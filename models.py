"""
Modelos de la base de datos (tablas).
"""
from sqlalchemy import (
    Column, Integer, String, Float, Boolean, DateTime, ForeignKey, Text, UniqueConstraint
)
from sqlalchemy.orm import relationship
from datetime import datetime

from database import Base


class Proveedor(Base):
    """
    Proveedor que surte productos a la tienda (ej. Coca-Cola, Gamesa,
    Marinela). Se usa para agrupar productos por proveedor y así poder
    sugerir pedidos de acuerdo a las ventas cuando el proveedor pasa a
    levantar el pedido.
    """
    __tablename__ = "proveedores"

    id = Column(Integer, primary_key=True, index=True)
    nombre = Column(String, unique=True, index=True, nullable=False)
    contacto = Column(String, default="")   # nombre de la persona de contacto
    telefono = Column(String, default="")
    # Día en que el proveedor pasa a levantar pedido: 0=lunes ... 6=domingo.
    # Null = sin día fijo (pasa cuando se le habla).
    dia_visita = Column(Integer, nullable=True)
    # Cada cuántos días pasa el proveedor (7 = semanal, 15 = quincenal, etc).
    # Se usa para calcular cuánto stock hay que cubrir hasta la siguiente visita.
    frecuencia_dias = Column(Integer, nullable=False, default=7)
    notas = Column(Text, default="")
    activo = Column(Boolean, default=True)  # False = "dado de baja"
    fecha_creacion = Column(DateTime, default=datetime.now)

    productos = relationship("Producto", back_populates="proveedor")


class Producto(Base):
    __tablename__ = "productos"

    id = Column(Integer, primary_key=True, index=True)
    codigo_barras = Column(String, unique=True, index=True, nullable=False)
    nombre = Column(String, nullable=False)
    descripcion = Column(Text, default="")
    categoria = Column(String, default="General")
    precio_venta = Column(Float, nullable=False, default=0.0)
    costo = Column(Float, default=0.0)
    stock = Column(Float, default=0)
    stock_minimo = Column(Float, default=0)
    # Nivel máximo de stock que ha tenido este producto. NO se captura a
    # mano: se actualiza solo cada vez que el stock sube (entrada de
    # inventario, ajuste hacia arriba, alta con stock inicial, importación
    # de Excel) y supera el máximo registrado hasta ahora. Es la base del
    # módulo de sugerencia de pedido: "sugerido = stock_maximo - stock".
    stock_maximo = Column(Float, default=0)
    activo = Column(Boolean, default=True)  # False = "dado de baja"
    fecha_creacion = Column(DateTime, default=datetime.now)

    # Proveedor que surte este producto (opcional). Es la base para el
    # módulo de sugerencia de pedidos por proveedor.
    proveedor_id = Column(Integer, ForeignKey("proveedores.id"), nullable=True)
    proveedor = relationship("Proveedor", back_populates="productos")

    @property
    def proveedor_nombre(self):
        return self.proveedor.nombre if self.proveedor else None

    # 'pieza' (se vende por unidad entera) o 'kg' (se vende a granel, por peso).
    # Cuando es 'kg', precio_venta es el precio por kilogramo y stock se
    # mide en kilogramos (acepta decimales, ej. 3.250 kg).
    unidad_venta = Column(String, nullable=False, default="pieza")

    # False = el producto NO tiene código de barras real (ej. tortillas,
    # verdura, huevo suelto). Se le asigna un código interno automático
    # (no se le pide al cajero) y aparece como botón en "Venta rápida"
    # dentro de la pantalla de Vender, en vez de tener que escanearlo.
    requiere_codigo = Column(Boolean, nullable=False, default=True)

    movimientos = relationship("MovimientoInventario", back_populates="producto")
    detalles_venta = relationship("VentaDetalle", back_populates="producto")


class MovimientoInventario(Base):
    """Historial de entradas, salidas y ajustes de inventario."""
    __tablename__ = "movimientos_inventario"

    id = Column(Integer, primary_key=True, index=True)
    producto_id = Column(Integer, ForeignKey("productos.id"), nullable=False)
    tipo = Column(String, nullable=False)  # 'entrada', 'salida', 'ajuste', 'venta'
    cantidad = Column(Float, nullable=False)
    # Costo pagado por unidad en esta entrada (solo aplica a tipo='entrada';
    # el costo puede variar de una compra a otra). Con esto se puede calcular
    # el gasto real de cada compra (cantidad * costo_unitario), en vez de
    # depender del costo "actual" del producto, que solo refleja la última
    # compra registrada.
    costo_unitario = Column(Float, nullable=True)
    motivo = Column(String, default="")
    fecha = Column(DateTime, default=datetime.now)

    producto = relationship("Producto", back_populates="movimientos")


class Venta(Base):
    __tablename__ = "ventas"

    id = Column(Integer, primary_key=True, index=True)
    fecha = Column(DateTime, default=datetime.now)
    total = Column(Float, nullable=False, default=0.0)
    metodo_pago = Column(String, default="efectivo")  # efectivo, tarjeta, transferencia
    cancelada = Column(Boolean, default=False)
    usuario_id = Column(Integer, ForeignKey("usuarios.id"), nullable=True)

    detalles = relationship("VentaDetalle", back_populates="venta", cascade="all, delete-orphan")
    usuario = relationship("Usuario", back_populates="ventas")


class VentaDetalle(Base):
    __tablename__ = "venta_detalles"

    id = Column(Integer, primary_key=True, index=True)
    venta_id = Column(Integer, ForeignKey("ventas.id"), nullable=False)
    producto_id = Column(Integer, ForeignKey("productos.id"), nullable=False)
    cantidad = Column(Float, nullable=False)
    precio_unitario = Column(Float, nullable=False)
    subtotal = Column(Float, nullable=False)

    venta = relationship("Venta", back_populates="detalles")
    producto = relationship("Producto", back_populates="detalles_venta")


class Usuario(Base):
    """Cajeros y administradores del sistema."""
    __tablename__ = "usuarios"

    id = Column(Integer, primary_key=True, index=True)
    username = Column(String, unique=True, index=True, nullable=False)
    nombre_completo = Column(String, default="")
    password_hash = Column(String, nullable=False)
    rol = Column(String, nullable=False, default="cajero")  # 'admin' o 'cajero'
    activo = Column(Boolean, default=True)
    fecha_creacion = Column(DateTime, default=datetime.now)

    sesiones = relationship("Sesion", back_populates="usuario")
    ventas = relationship("Venta", back_populates="usuario")


class Sesion(Base):
    """Token de sesión activo de un usuario (login simple sin JWT)."""
    __tablename__ = "sesiones"

    id = Column(Integer, primary_key=True, index=True)
    token = Column(String, unique=True, index=True, nullable=False)
    usuario_id = Column(Integer, ForeignKey("usuarios.id"), nullable=False)
    expira = Column(DateTime, nullable=False)
    creado = Column(DateTime, default=datetime.now)

    usuario = relationship("Usuario", back_populates="sesiones")


class PermisoRol(Base):
    """
    Permisos granulares por rol (Administración > Permisos).

    Por ahora solo se usan para el rol 'cajero'. La columna `modulo`
    guarda la clave de la acción, con formato "modulo.accion"
    (ej. "productos.editar", "inventario.movimiento", "reportes.cancelar").

    Compatibilidad: registros antiguos sin punto (solo "productos") se
    interpretan como "todas las acciones de ese módulo".

    El rol 'admin' siempre tiene acceso total. Usuarios y permisos no son
    configurables: quedan exclusivos de admin.
    """
    __tablename__ = "permisos_rol"

    id = Column(Integer, primary_key=True, index=True)
    rol = Column(String, nullable=False)      # por ahora solo 'cajero'
    modulo = Column(String, nullable=False)   # clave "productos.ver", "gastos.agregar", etc.
    permitido = Column(Boolean, default=False)

    __table_args__ = (UniqueConstraint("rol", "modulo", name="uq_permisos_rol_modulo"),)



class Configuracion(Base):
    """
    Ajustes generales del negocio (clave → valor). Hoy se usa sobre todo
    para el nombre de la tienda, pero el esquema admite más claves sin
    migrar tablas (ej. dirección, teléfono, RFC en el futuro).
    """
    __tablename__ = "configuracion"

    clave = Column(String, primary_key=True)
    valor = Column(Text, default="")


class NotificacionDescartada(Base):
    """
    Registro de que el usuario ya "quitó" una notificación del centro de
    notificaciones (dashboard / campana). No se guardan las notificaciones
    en sí (esas se calculan al vuelo, en tiempo real, a partir de
    proveedores y stock); solo se guarda qué avisos ya se descartaron
    para no volver a mostrarlos.

    La `clave` identifica de forma única cada notificación posible:
      - "proveedor_visita:<id_proveedor>:<YYYY-MM-DD>"  → incluye la fecha,
        así que descartar el aviso de hoy no descarta el de mañana.
      - "stock_bajo:<id_producto>"                       → sin fecha; se
        vuelve a mostrar sola si el producto se recupera (stock por
        arriba del mínimo) y luego vuelve a bajar.
    """
    __tablename__ = "notificaciones_descartadas"

    id = Column(Integer, primary_key=True, index=True)
    clave = Column(String, unique=True, index=True, nullable=False)
    usuario_id = Column(Integer, ForeignKey("usuarios.id"), nullable=True)
    fecha = Column(DateTime, default=datetime.now)


class CorteCaja(Base):
    """
    Corte de caja al cerrar el día (o el turno). Guarda lo que el sistema
    esperaba en efectivo según las ventas del periodo, lo que el cajero
    contó en billetes/monedas, y la diferencia (faltante o sobrante).
    """
    __tablename__ = "cortes_caja"

    id = Column(Integer, primary_key=True, index=True)
    # Día que se está cerrando (no necesariamente la hora exacta del clic).
    fecha_corte = Column(DateTime, nullable=False, default=datetime.now)
    usuario_id = Column(Integer, ForeignKey("usuarios.id"), nullable=True)
    num_ventas = Column(Integer, default=0)
    total_ventas = Column(Float, default=0.0)
    total_efectivo = Column(Float, default=0.0)
    total_tarjeta = Column(Float, default=0.0)
    total_transferencia = Column(Float, default=0.0)
    # Dinero en billetes/monedas que el cajero contó al cerrar.
    efectivo_contado = Column(Float, nullable=False, default=0.0)
    # contado - total_efectivo: positivo = sobrante, negativo = faltante.
    diferencia = Column(Float, default=0.0)
    notas = Column(Text, default="")
    fecha_registro = Column(DateTime, default=datetime.now)

    usuario = relationship("Usuario")

    @property
    def registrado_por(self):
        if not self.usuario:
            return None
        return self.usuario.nombre_completo or self.usuario.username


class EscaneoRemoto(Base):
    """
    Puente entre el celular (que escanea) y la computadora (donde se está
    trabajando en el POS). El celular hace login con una cuenta del
    sistema y manda aquí el código que acaba de leer; la computadora, con
    la sesión de esa MISMA cuenta abierta, pregunta cada cierto tiempo
    "¿hay algo nuevo para mí?" y lo consume.

    Opcionalmente trae `cantidad`: cuando el cajero captura gramos/kg o
    piezas desde el celular, llega ya lista para sumarse al carrito de
    la PC sin volver a pedir la cantidad en pantalla.

    No hace falta emparejar dispositivos: el "amarre" entre celular y
    compu es, sencillamente, que ambos iniciaron sesión con el mismo
    usuario (por eso conviene una cuenta de cajero dedicada para esto si
    varias personas van a usar el celular a la vez).
    """
    __tablename__ = "escaneos_remotos"

    id = Column(Integer, primary_key=True, index=True)
    usuario_id = Column(Integer, ForeignKey("usuarios.id"), nullable=False, index=True)
    codigo_barras = Column(String, nullable=False)
    # Cantidad opcional capturada en el celular (kg o piezas). Null =
    # solo se mandó el código (flujo clásico: la PC decide cantidad).
    cantidad = Column(Float, nullable=True)
    fecha = Column(DateTime, default=datetime.now)
    # Se marca True en cuanto la computadora lo recoge, para no volver a
    # entregarlo ni acumular basura de escaneos viejos sin usar.
    consumido = Column(Boolean, default=False)


class OtroGasto(Base):
    """
    Gastos del negocio que no son compra de mercancía: renta, luz, agua,
    internet, sueldos, mantenimiento, etc. Se capturan a mano (no se
    generan solos como las entradas/salidas de inventario) y se suman en
    el reporte junto con las compras y las mermas para calcular la
    utilidad neta real del negocio.
    """
    __tablename__ = "otros_gastos"

    id = Column(Integer, primary_key=True, index=True)
    concepto = Column(String, nullable=False)  # ej. "Renta local", "Sueldo Juan (quincena)"
    # Categoría para poder agrupar/filtrar: renta, luz, agua, internet,
    # sueldo, mantenimiento, otro.
    categoria = Column(String, nullable=False, default="otro")
    monto = Column(Float, nullable=False)
    # Fecha del gasto (puede capturarse días después de que ocurrió, por
    # eso es independiente de fecha_creacion).
    fecha = Column(DateTime, default=datetime.now)
    notas = Column(Text, default="")
    usuario_id = Column(Integer, ForeignKey("usuarios.id"), nullable=True)
    fecha_creacion = Column(DateTime, default=datetime.now)

    usuario = relationship("Usuario")

    @property
    def registrado_por(self):
        if not self.usuario:
            return None
        return self.usuario.nombre_completo or self.usuario.username
