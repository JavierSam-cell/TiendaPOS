"""
Autenticación simple por token, sin dependencias externas (JWT, bcrypt, etc.):
- Contraseñas: hash con PBKDF2-HMAC-SHA256 (parte de la librería estándar de Python).
- Sesión: token aleatorio guardado en la tabla `sesiones` con fecha de expiración.
"""
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta

from fastapi import Depends, HTTPException, Header
from sqlalchemy.orm import Session

import models
from database import get_db

PBKDF2_ITERACIONES = 260_000
TOKEN_DURACION_HORAS = 12


def hash_password(password: str, salt: str = None) -> str:
    salt = salt or secrets.token_hex(16)
    derivado = hashlib.pbkdf2_hmac(
        "sha256", password.encode(), salt.encode(), PBKDF2_ITERACIONES
    )
    return f"{salt}${derivado.hex()}"


def verificar_password(password: str, password_guardado: str) -> bool:
    try:
        salt, _ = password_guardado.split("$")
    except ValueError:
        return False
    return hmac.compare_digest(hash_password(password, salt), password_guardado)


def crear_sesion(db: Session, usuario: "models.Usuario") -> str:
    token = secrets.token_urlsafe(32)
    sesion = models.Sesion(
        token=token,
        usuario_id=usuario.id,
        expira=datetime.utcnow() + timedelta(hours=TOKEN_DURACION_HORAS),
    )
    db.add(sesion)
    db.commit()
    return token


def obtener_usuario_actual(
    authorization: str = Header(default=None), db: Session = Depends(get_db)
) -> "models.Usuario":
    """Dependency de FastAPI: valida el header 'Authorization: Bearer <token>'."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(401, "No autenticado")

    token = authorization.split(" ", 1)[1]
    sesion = db.query(models.Sesion).filter(models.Sesion.token == token).first()
    if not sesion or sesion.expira < datetime.utcnow():
        raise HTTPException(401, "Sesión inválida o expirada, vuelve a iniciar sesión")

    usuario = db.query(models.Usuario).get(sesion.usuario_id)
    if not usuario or not usuario.activo:
        raise HTTPException(401, "Usuario inactivo")
    return usuario


def requiere_rol(*roles_permitidos):
    """Uso: Depends(requiere_rol('admin'))  o  Depends(requiere_rol('admin', 'cajero'))"""
    def dependencia(usuario: models.Usuario = Depends(obtener_usuario_actual)):
        if usuario.rol not in roles_permitidos:
            raise HTTPException(403, "No tienes permiso para realizar esta acción")
        return usuario
    return dependencia


def requiere_permiso(*claves: str):
    """
    Dependency de FastAPI para endpoints con permisos granulares.

    - admin: siempre pasa.
    - cajero (u otro rol): pasa si tiene al menos UNA de las claves
      indicadas en 'permisos_rol' con permitido=True.

    Las claves son del tipo "productos.ver", "inventario.movimiento", etc.
    Compatibilidad: también acepta el nombre de módulo legacy ("productos")
    y lo trata como "cualquier acción de ese módulo" o el registro legacy.

    Uso:
      Depends(auth.requiere_permiso("productos.editar"))
      Depends(auth.requiere_permiso("productos.ver", "productos.editar"))
    """
    def dependencia(
        usuario: models.Usuario = Depends(obtener_usuario_actual),
        db: Session = Depends(get_db),
    ):
        if usuario.rol == "admin":
            return usuario

        filas = (
            db.query(models.PermisoRol)
            .filter(models.PermisoRol.rol == usuario.rol, models.PermisoRol.permitido == True)
            .all()
        )
        concedidos = {f.modulo for f in filas}

        for clave in claves:
            if clave in concedidos:
                return usuario
            # Legacy: permiso de módulo completo ("productos")
            if "." in clave:
                modulo = clave.split(".", 1)[0]
                if modulo in concedidos:
                    return usuario
            else:
                # Se pidió un módulo genérico: cualquier clave "modulo.*"
                if any(c == clave or c.startswith(clave + ".") for c in concedidos):
                    return usuario

        raise HTTPException(403, "No tienes permiso para realizar esta acción")
    return dependencia
