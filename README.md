# Sistema de Punto de Venta (POS) - Local

Sistema completo de punto de venta que corre en tu red WiFi local.
Backend en **Python (FastAPI + SQLAlchemy + SQLite)**, frontend web que
funciona en la PC y en el celular (usando la cámara para escanear
códigos de barras, sin hardware adicional).

## 1. Instalación

Necesitas Python 3.9+ instalado. Abre una terminal en la carpeta del
proyecto y ejecuta:

```bash
# (opcional pero recomendado) crear entorno virtual
python -m venv venv
venv\Scripts\activate        # en Windows
source venv/bin/activate     # en Mac/Linux

# instalar dependencias
pip install -r requirements.txt
```

## 2. Ejecutar el servidor

```bash
.\venv\Scripts\Activate.ps1
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

- `--host 0.0.0.0` es la clave: hace que el servidor sea visible desde
  otros dispositivos de tu red (como el celular), no solo desde tu PC.
- La base de datos `pos.db` (SQLite) se crea sola la primera vez que
  corres el servidor.

## 3. Encontrar la IP de tu PC en la red local

- **Windows**: abre CMD y escribe `ipconfig` → busca "Dirección IPv4"
  (ejemplo: `192.168.1.100`)
- **Mac/Linux**: abre la terminal y escribe `ifconfig` o `ip addr` →
  busca algo como `192.168.1.100`

Asegúrate de que tu celular esté conectado **a la misma red WiFi**
que tu PC.

## 4. Acceder al sistema

- **Desde tu PC**: `http://localhost:8000`
- **Desde tu celular**: `http://192.168.1.100:8000` (usa la IP real
  de tu PC que obtuviste en el paso 3)

La primera vez que uses el escáner desde el celular, el navegador
pedirá permiso para usar la cámara — acéptalo. Si usas Chrome en
Android o Safari en iPhone funciona sin instalar nada extra.

> **Nota:** algunos navegadores solo permiten acceso a la cámara en
> conexiones seguras (HTTPS) o en `localhost`. Chrome en Android
> normalmente permite cámara en `http://` dentro de la red local sin
> problema. Si tu navegador la bloquea, hay dos soluciones simples:
> 1. Usar Chrome (suele ser el más permisivo en red local).
> 2. Generar un certificado local con `mkcert` y correr uvicorn con
>    `--ssl-keyfile` y `--ssl-certfile` para servir por HTTPS.

## 5. Iniciar sesión

Al abrir el sistema por primera vez se crea automáticamente un
usuario administrador:

- **Usuario:** `admin`
- **Contraseña:** `admin123`

Verás este mensaje en la terminal donde corre `uvicorn` la primera
vez. **Cámbiala o crea tu propio admin y deshabilita este** desde la
pestaña "Usuarios" en cuanto puedas.

### Roles

- **Administrador**: acceso a todo — vender, productos, inventario,
  reportes (con exportación) y gestión de usuarios/cajeros.
- **Cajero**: solo puede vender (buscar productos activos, armar el
  carrito y cobrar). No ve productos, inventario, reportes ni
  usuarios.

## 6. Qué puedes hacer

- **Vender**: escanea productos con la cámara o teclea el código,
  arma el carrito, elige método de pago y cobra. El stock se
  descuenta automáticamente y la venta queda ligada al cajero que la
  hizo.
- **Producto no encontrado al escanear**: si el código escaneado no
  existe, aparece un aviso al momento. Si quien está vendiendo es
  admin, puede darlo de alta ahí mismo (nombre, precio, stock) y se
  agrega al carrito sin salir de la pantalla de venta. Si es cajero,
  se le indica que pida a un admin que lo registre.
- **Productos** *(solo admin)*: alta, edición y baja (lógica, no se
  borra el historial) de productos. Puedes reactivarlos cuando
  quieras.
- **Inventario** *(solo admin)*: registra entradas (compras/
  reposición), salidas (mermas) y ajustes de stock. Alerta
  automática de productos con stock bajo. Historial completo de
  movimientos.
- **Reportes** *(solo admin)*: ingresos totales, número de ventas,
  ticket promedio, top de productos más vendidos, e historial de
  ventas (con quién vendió cada una) con opción de cancelar (esto
  regresa el stock).
  - **Exportar a Excel**: genera un `.xlsx` con 3 hojas (Resumen,
    Top productos, Ventas), respetando el filtro de fechas activo.
  - **Exportar a PDF**: genera un `.pdf` con el mismo contenido,
    listo para imprimir o archivar.
- **Usuarios** *(solo admin)*: crear cajeros o administradores,
  habilitar/deshabilitar cuentas.

## 7. Estructura del proyecto

```
pos-system/
├── main.py            # API y endpoints de FastAPI
├── models.py           # Tablas de la base de datos (SQLAlchemy)
├── schemas.py           # Validación de datos (Pydantic)
├── database.py           # Configuración de la conexión a SQLite
├── auth.py                # Login, hash de contraseñas y control de roles
├── requirements.txt
├── pos.db                # se crea automáticamente al arrancar
└── static/
    ├── index.html         # interfaz web (login + tabs)
    ├── style.css
    └── app.js              # lógica del frontend + escáner de cámara
```

## 8. Notas de seguridad

- Las contraseñas se guardan con hash **PBKDF2-HMAC-SHA256** (no en
  texto plano), usando solo la librería estándar de Python.
- El login genera un **token de sesión** que expira a las 12 horas;
  se manda en cada petición como `Authorization: Bearer <token>`.
- Esto es apropiado para uso en una red local de confianza (tu
  tienda). Si algún día expones el sistema a internet, considera
  agregar HTTPS y limitar los intentos de login.

## 9. Ideas para seguir creciendo el sistema

- Imprimir tickets (usando una impresora térmica USB/Bluetooth
  conectada a la PC, con `python-escpos`).
- Migrar de SQLite a PostgreSQL si la tienda crece o quieres acceso
  desde fuera de la red local (cambiando solo una línea en
  `database.py`).
- Reportes de ventas o comisiones por cajero.
- Recuperación de contraseña / expiración forzada de la clave inicial.

## 10. Documentación interactiva de la API

FastAPI genera automáticamente documentación interactiva. Con el
servidor corriendo, visita:

```
http://localhost:8000/docs
```

Ahí puedes probar cada endpoint directamente desde el navegador.
