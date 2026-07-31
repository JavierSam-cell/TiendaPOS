"""
Schemas Pydantic: validan los datos que entran/salen de la API.
"""
from pydantic import BaseModel, Field, field_validator
from typing import Optional, List
from datetime import datetime, date
import re


def _validar_password_fuerte(password: str) -> str:
    """Misma regla que se valida en el frontend (app.js):
    mínimo 8 caracteres, 1 mayúscula, 1 minúscula, 1 número y 1 carácter especial.
    Se repite aquí porque el frontend se puede saltar (API directa, JS deshabilitado, etc.)."""
    errores = []
    if len(password) < 8:
        errores.append("mínimo 8 caracteres")
    if not re.search(r"[A-Z]", password):
        errores.append("al menos 1 mayúscula")
    if not re.search(r"[a-z]", password):
        errores.append("al menos 1 minúscula")
    if not re.search(r"[0-9]", password):
        errores.append("al menos 1 número")
    if not re.search(r"[!@#$%^&*]", password):
        errores.append("al menos 1 carácter especial (!@#$%^&*)")
    if errores:
        raise ValueError("La contraseña no cumple: " + ", ".join(errores))
    return password


# ---------- Producto ----------
class ProductoBase(BaseModel):
    codigo_barras: Optional[str] = None  # opcional: se autogenera si requiere_codigo=False
    nombre: str = Field(min_length=1)
    descripcion: Optional[str] = ""
    categoria: Optional[str] = "General"
    precio_venta: float = Field(ge=0)
    costo: float = Field(ge=0, default=0.0)
    stock: float = Field(ge=0, default=0)
    stock_minimo: float = Field(ge=0, default=0)
    unidad_venta: str = "pieza"          # 'pieza' o 'kg'
    requiere_codigo: bool = True          # False = producto a granel / sin código
    proveedor_id: Optional[int] = None    # proveedor que surte este producto

    @field_validator("nombre")
    @classmethod
    def nombre_no_vacio(cls, v: str) -> str:
        if v is None:
            raise ValueError("El nombre es obligatorio")
        v = v.strip()
        if not v:
            raise ValueError("El nombre no puede estar vacío")
        return v


class ProductoCrear(ProductoBase):
    pass


class ProductoActualizar(BaseModel):
    nombre: Optional[str] = None
    descripcion: Optional[str] = None
    categoria: Optional[str] = None
    precio_venta: Optional[float] = Field(default=None, ge=0)
    costo: Optional[float] = Field(default=None, ge=0)
    stock_minimo: Optional[float] = Field(default=None, ge=0)
    unidad_venta: Optional[str] = None
    requiere_codigo: Optional[bool] = None
    proveedor_id: Optional[int] = None

    @field_validator("nombre")
    @classmethod
    def nombre_no_vacio_si_viene(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        v = v.strip()
        if not v:
            raise ValueError("El nombre no puede estar vacío")
        return v


class ProductoOut(ProductoBase):
    id: int
    activo: bool
    fecha_creacion: datetime
    proveedor_nombre: Optional[str] = None
    # Nivel más alto de stock registrado para este producto. Es dinámico
    # (se actualiza solo con cada entrada de mercancía), no se manda al
    # crear/editar el producto.
    stock_maximo: float = 0
    # Sin ge=0: si por un bug antiguo quedara stock negativo, el catálogo
    # debe seguir listando el producto en vez de devolver HTTP 500.
    stock: float = 0

    class Config:
        from_attributes = True


# ---------- Proveedor ----------
class ProveedorBase(BaseModel):
    nombre: str
    contacto: Optional[str] = ""
    telefono: Optional[str] = ""
    dia_visita: Optional[int] = Field(default=None, ge=0, le=6)  # 0=lunes ... 6=domingo
    frecuencia_dias: int = Field(default=7, ge=1)
    notas: Optional[str] = ""


class ProveedorCrear(ProveedorBase):
    pass


class ProveedorActualizar(BaseModel):
    nombre: Optional[str] = None
    contacto: Optional[str] = None
    telefono: Optional[str] = None
    dia_visita: Optional[int] = Field(default=None, ge=0, le=6)
    frecuencia_dias: Optional[int] = Field(default=None, ge=1)
    notas: Optional[str] = None
    activo: Optional[bool] = None


class ProveedorOut(ProveedorBase):
    id: int
    activo: bool
    fecha_creacion: datetime

    class Config:
        from_attributes = True


# ---------- Sugerencia de pedido ----------
class SugerenciaPedidoItem(BaseModel):
    producto_id: int
    codigo_barras: str
    nombre: str
    stock: float
    stock_minimo: float
    stock_maximo: float
    sugerido: float
    motivo: str
    # Costo unitario actual del producto. Se usa en el frontend para
    # calcular en vivo el gasto total que representará el pedido, tal
    # como se calcula al dar de alta un producto en Inventario.
    costo: float = 0.0
    unidad_venta: str = "pieza"


class SugerenciaPedidoOut(BaseModel):
    proveedor: ProveedorOut
    items: List[SugerenciaPedidoItem]


# ---------- Hacer pedido (a partir de la sugerencia) ----------
class PedidoItemCrear(BaseModel):
    producto_id: int
    cantidad: float = Field(ge=0)


class PedidoCrear(BaseModel):
    items: List[PedidoItemCrear]


class PedidoConfirmadoItem(BaseModel):
    producto_id: int
    nombre: str
    cantidad: float
    costo_unitario: float
    subtotal: float
    stock_nuevo: float


class PedidoConfirmado(BaseModel):
    proveedor_id: int
    proveedor_nombre: str
    items: List[PedidoConfirmadoItem]
    total_gasto: float
    total_productos: int
    total_piezas: float


# ---------- Inventario ----------
class MovimientoCrear(BaseModel):
    codigo_barras: str
    tipo: str  # 'entrada', 'salida', 'ajuste'
    # La regla fina (entrada/salida > 0, ajuste >= 0) se aplica en el endpoint,
    # porque el significado de "cantidad" cambia según el tipo.
    cantidad: float
    # Costo pagado por unidad (solo tiene sentido para 'entrada'). Opcional:
    # si no lo mandas, el movimiento no se cuenta en el reporte de gastos.
    costo_unitario: Optional[float] = Field(default=None, ge=0)
    motivo: Optional[str] = ""


class MovimientoOut(BaseModel):
    id: int
    producto_id: int
    tipo: str
    cantidad: float
    costo_unitario: Optional[float] = None
    motivo: str
    fecha: datetime

    class Config:
        from_attributes = True


# ---------- Ventas ----------
class ItemVenta(BaseModel):
    codigo_barras: str
    cantidad: float = Field(gt=0)


class VentaCrear(BaseModel):
    items: List[ItemVenta]
    metodo_pago: str = "efectivo"


class VentaDetalleOut(BaseModel):
    producto_id: int
    nombre_producto: Optional[str] = None
    cantidad: float
    precio_unitario: float
    subtotal: float

    class Config:
        from_attributes = True


class VentaOut(BaseModel):
    id: int
    fecha: datetime
    total: float
    metodo_pago: str
    cancelada: bool
    vendido_por: Optional[str] = None
    detalles: List[VentaDetalleOut] = []

    class Config:
        from_attributes = True


# ---------- Usuarios / Login ----------
class LoginRequest(BaseModel):
    username: str
    password: str


class UsuarioCrear(BaseModel):
    username: str
    password: str
    nombre_completo: Optional[str] = ""
    rol: str = "cajero"  # 'admin' o 'cajero'

    @field_validator("password")
    @classmethod
    def password_fuerte(cls, v):
        return _validar_password_fuerte(v)


class UsuarioActualizar(BaseModel):
    nombre_completo: Optional[str] = None
    rol: Optional[str] = None
    password: Optional[str] = None
    activo: Optional[bool] = None

    @field_validator("password")
    @classmethod
    def password_fuerte(cls, v):
        # Solo se valida si mandan una contraseña nueva (puede venir None
        # o "" cuando solo se edita el rol/nombre, sin cambiar la clave).
        if v:
            return _validar_password_fuerte(v)
        return v


class UsuarioOut(BaseModel):
    id: int
    username: str
    nombre_completo: str
    rol: str
    activo: bool
    fecha_creacion: datetime

    class Config:
        from_attributes = True


class TokenResponse(BaseModel):
    token: str
    usuario: UsuarioOut


# ---------- Permisos por rol (Administración > Permisos) ----------
# Permisos granulares por acción. "usuarios" / "permisos" quedan fuera a
# propósito: la gestión de cuentas y de permisos es siempre admin-only.
#
# Formato de clave: "modulo.accion" (ej. "productos.editar").
# Se guardan en permisos_rol.modulo (columna string existente).
ACCIONES_POR_MODULO = {
    "productos": [
        ("ver", "Ver catálogo"),
        ("agregar", "Agregar productos"),
        ("editar", "Editar productos"),
        ("baja", "Dar de baja / reactivar"),
        ("importar", "Importar / exportar Excel"),
    ],
    "inventario": [
        ("ver", "Ver movimientos y alertas de stock"),
        ("movimiento", "Registrar entradas / salidas / ajustes"),
    ],
    "proveedores": [
        ("ver", "Ver lista de proveedores"),
        ("agregar", "Agregar proveedores"),
        ("editar", "Editar proveedores"),
        ("baja", "Dar de baja / reactivar"),
        ("sugerencia", "Sugerencia de pedido"),
    ],
    "gastos": [
        ("ver", "Ver gastos registrados"),
        ("agregar", "Registrar gastos"),
        ("eliminar", "Eliminar gastos"),
    ],
    "reportes": [
        ("ver", "Ver reportes y exportar"),
        ("cancelar", "Cancelar ventas"),
    ],
    "caja": [
        ("ver", "Ver historial de cortes de caja"),
        ("cortar", "Hacer corte de caja"),
    ],
}

# Claves planas: ["productos.ver", "productos.agregar", ...]
CLAVES_PERMISO = [
    f"{modulo}.{accion}"
    for modulo, acciones in ACCIONES_POR_MODULO.items()
    for accion, _ in acciones
]

# Compatibilidad: permisos antiguos eran solo el nombre del módulo
# ("productos", "inventario", ...). Si aún existen en la BD, se expanden
# a todas las acciones de ese módulo.
MODULOS_LEGACY = list(ACCIONES_POR_MODULO.keys())


# La respuesta de permisos es un dict plano {clave: bool}.
# No usamos un modelo rígido para poder añadir acciones sin romper el
# esquema de respuesta; el frontend y _obtener_permisos_* rellenan
# siempre todas las CLAVES_PERMISO.

class PermisosActualizar(BaseModel):
    """Acepta cualquier subconjunto de claves de permiso (extra=allow)."""
    class Config:
        extra = "allow"




# ---------- Configuración del negocio ----------
class ConfiguracionOut(BaseModel):
    nombre_tienda: str = "Mi Tienda"


class ConfiguracionActualizar(BaseModel):
    nombre_tienda: Optional[str] = None

# ---------- Otros gastos (renta, luz, sueldos, etc.) ----------
class OtroGastoBase(BaseModel):
    concepto: str
    # renta, luz, agua, internet, sueldo, mantenimiento, otro
    categoria: str = "otro"
    monto: float = Field(gt=0)
    # Fecha en que ocurrió el gasto. Si no se manda, se usa hoy (permite
    # capturar gastos de días anteriores, ej. la renta del mes pasado).
    fecha: Optional[date] = None
    notas: Optional[str] = ""


class OtroGastoCrear(OtroGastoBase):
    pass


class OtroGastoOut(BaseModel):
    id: int
    concepto: str
    categoria: str
    monto: float
    fecha: datetime
    notas: str
    registrado_por: Optional[str] = None

    class Config:
        from_attributes = True


# ---------- Escaneo remoto (celular -> computadora) ----------
class EscaneoRemotoCrear(BaseModel):
    codigo_barras: str = Field(min_length=1)
    # Cantidad opcional (piezas o kg) capturada en el celular. Si viene,
    # la PC la suma directo al carrito sin abrir el modal de cantidad.
    cantidad: Optional[float] = Field(default=None, gt=0)


class EscaneoRemotoOut(BaseModel):
    # None cuando no hay ningún escaneo nuevo pendiente.
    codigo_barras: Optional[str] = None
    cantidad: Optional[float] = None
    fecha: Optional[datetime] = None


# ---------- Notificaciones en tiempo real (dashboard / campana) ----------
class NotificacionOut(BaseModel):
    # Identifica la notificación de forma única; se usa para descartarla.
    clave: str
    tipo: str            # "proveedor_visita" | "stock_bajo"
    icono: str
    titulo: str
    mensaje: str
    # Pestaña del menú a la que lleva el botón de acción (data-tab del frontend).
    tab_destino: str
    texto_boton: str
    # "alta" (urgente, rojo) | "media" (naranja) | "info" (verde/neutro)
    prioridad: str
    fecha: datetime


class NotificacionDescartar(BaseModel):
    clave: str


# ---------- Corte de caja ----------
class CorteCajaCrear(BaseModel):
    # Día que se cierra. Si no se manda, se usa hoy.
    fecha_corte: Optional[date] = None
    efectivo_contado: float = Field(ge=0)
    notas: Optional[str] = ""


class CorteCajaOut(BaseModel):
    id: int
    fecha_corte: datetime
    num_ventas: int
    total_ventas: float
    total_efectivo: float
    total_tarjeta: float
    total_transferencia: float
    efectivo_contado: float
    diferencia: float
    notas: str
    fecha_registro: datetime
    registrado_por: Optional[str] = None

    class Config:
        from_attributes = True


class PrecorteOut(BaseModel):
    """Totales del día según el sistema, antes de confirmar el corte."""
    fecha: date
    num_ventas: int
    total_ventas: float
    total_efectivo: float
    total_tarjeta: float
    total_transferencia: float
    ya_hay_corte: bool
