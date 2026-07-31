const API = "/api";
let carrito = []; // [{codigo_barras, nombre, precio, cantidad}]
let sesion = { token: null, usuario: null };
let ultimoCodigoNoEncontrado = null;

// ---------------------------------------------------------
// Utilidades
// ---------------------------------------------------------
function toast(msg, isError = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "show" + (isError ? " error" : "");
  setTimeout(() => (t.className = ""), 2500);
}

// Bip tipo escáner de supermercado al agregar un producto al carrito.
// Se genera con Web Audio API (sin archivo de sonido externo).
let _audioCtxBeep = null;
function sonidoBeepEscaneo() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!_audioCtxBeep) _audioCtxBeep = new AudioCtx();
    // Algunos navegadores suspenden el contexto hasta una interacción del usuario.
    if (_audioCtxBeep.state === "suspended") _audioCtxBeep.resume();

    const ctx = _audioCtxBeep;
    const ahora = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(1800, ahora);
    // Ataque rápido y caída corta: suena a "bip" de caja registradora.
    gain.gain.setValueAtTime(0.0001, ahora);
    gain.gain.exponentialRampToValueAtTime(0.22, ahora + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, ahora + 0.09);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ahora);
    osc.stop(ahora + 0.1);
  } catch (e) {
    // Si el navegador bloquea audio, no interrumpimos la venta.
  }
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (sesion.token) headers["Authorization"] = "Bearer " + sesion.token;

  const res = await fetch(API + path, { headers, ...options });
  if (res.status === 401) {
    cerrarSesionLocal();
    toast("Tu sesión expiró, inicia sesión de nuevo", true);
    throw new Error("No autenticado");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || "Error en la petición");
  return data;
}

/** Descarga un archivo protegido (requiere Authorization) como blob. */
let _descargaEnCurso = false;
async function descargarArchivo(path, nombreArchivo) {
  if (_descargaEnCurso) return;
  _descargaEnCurso = true;
  try {
    const res = await fetch(API + path, {
      headers: { Authorization: "Bearer " + sesion.token },
    });
    if (!res.ok) {
      toast("No se pudo generar el archivo", true);
      return;
    }
    const blob = await res.blob();
    if (!blob || blob.size === 0) {
      toast("El archivo generó vacío, intenta de nuevo", true);
      return;
    }
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = nombreArchivo;
    a.style.display = "none";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      window.URL.revokeObjectURL(url);
    }, 1500);
  } catch (e) {
    toast("No se pudo descargar el archivo", true);
  } finally {
    setTimeout(() => { _descargaEnCurso = false; }, 800);
  }
}

/** Sube un archivo (FormData) a un endpoint protegido y devuelve el JSON de respuesta. */
async function subirArchivo(path, campo, archivo) {
  const formData = new FormData();
  formData.append(campo, archivo);
  const res = await fetch(API + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + sesion.token },
    body: formData,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || "Error al importar el archivo");
  return data;
}

// ---------------------------------------------------------
// LOGIN / SESIÓN
// ---------------------------------------------------------
function cargarSesionGuardada() {
  const token = localStorage.getItem("pos_token");
  const usuario = localStorage.getItem("pos_usuario");
  if (token && usuario) {
    sesion.token = token;
    sesion.usuario = JSON.parse(usuario);
    mostrarApp();
  } else {
    mostrarLogin();
  }
}

let configNegocio = { nombre_tienda: "Mi Tienda" };

function aplicarNombreTienda(nombre) {
  const n = (nombre || "Mi Tienda").trim() || "Mi Tienda";
  configNegocio.nombre_tienda = n;
  document.querySelectorAll(".nombre-tienda-ui").forEach((el) => {
    if (el.classList.contains("nombre-tienda-ticket")) {
      el.textContent = n.toUpperCase();
    } else {
      el.textContent = n;
    }
  });
  document.title = "POS — " + n;
}

async function cargarConfiguracionPublica() {
  try {
    // Sin token: el endpoint es público para el login.
    const res = await fetch(API + "/configuracion");
    if (!res.ok) return;
    const data = await res.json();
    if (data && data.nombre_tienda) aplicarNombreTienda(data.nombre_tienda);
  } catch (e) {
    /* sin internet / servidor: se queda el default */
  }
}

async function cargarConfiguracionAdmin() {
  try {
    const data = await api("/configuracion");
    document.getElementById("cfg-nombre-tienda").value = data.nombre_tienda || "";
  } catch (e) {
    toast(e.message, true);
  }
}

function mostrarLogin() {
  document.getElementById("pantalla-login").style.display = "flex";
  document.getElementById("app").style.display = "none";
}

async function mostrarApp() {
  document.getElementById("pantalla-login").style.display = "none";
  document.getElementById("app").style.display = "flex";
  document.getElementById("usuario-info").textContent =
    `${sesion.usuario.nombre_completo || sesion.usuario.username} (${sesion.usuario.rol})`;

  const esAdmin = sesion.usuario.rol === "admin";
  document.querySelectorAll(".solo-admin").forEach((el) => {
    el.style.display = esAdmin ? "" : "none";
  });
  await aplicarPermisosModulos();
  aplicarNombreTienda(configNegocio.nombre_tienda);

  // Solo carga datos de catálogo si el usuario puede verlos (o es admin).
  // La venta y venta rápida sí se cargan siempre (vender es base del cajero).
  if (esAdmin || tienePermiso("productos.ver", "productos.editar", "productos.baja", "productos.importar", "productos.agregar")) {
    try { cargarProductos(); } catch (e) { /* sin permiso */ }
  }
  cargarVentaRapida();
  cargarProveedoresSelects();
  actualizarReloj();
  setInterval(actualizarReloj, 1000);

  // Notificaciones en tiempo real: primera carga inmediata (para que si
  // hoy pasa un proveedor o hay stock bajo, se vea desde que se abre el
  // sistema) y luego se refrescan solas cada 30s mientras la sesión siga
  // activa, sin que el usuario tenga que hacer nada.
  cargarResumenDia();
  cargarNotificaciones();
  if (!window._intervalNotificaciones) {
    window._intervalNotificaciones = setInterval(() => {
      cargarNotificaciones();
      cargarResumenDia();
    }, 30000);
  }

  // Al conectarse, cada rol va directo a su sección principal:
  // admin -> reportes (si tiene), cajero -> vender.
  const tabInicial = esAdmin ? "reportes" : "venta";
  const btnInicial = document.querySelector(`.tab-btn[data-tab="${tabInicial}"]`);
  if (btnInicial && btnInicial.style.display !== "none") btnInicial.click();
  else {
    const venta = document.querySelector('.tab-btn[data-tab="venta"]');
    if (venta) venta.click();
  }
}

/** Permisos efectivos del usuario en sesión (claves "modulo.accion" → bool). */
let permisosEfectivos = {};

function tienePermiso(...claves) {
  if (!sesion.usuario) return false;
  if (sesion.usuario.rol === "admin") return true;
  return claves.some((c) => !!permisosEfectivos[c]);
}

/**
 * Muestra/oculta ítems del menú según permisos granulares.
 * - [data-permiso="clave"]: visible si tiene esa clave.
 * - [data-permiso-any="a,b,c"]: visible si tiene al menos una.
 * - Grupos y secciones vacíos se ocultan por completo.
 * Admin siempre ve todo (salvo que no tenga la clase correspondiente).
 */
async function aplicarPermisosModulos() {
  const esAdmin = sesion.usuario.rol === "admin";
  if (!esAdmin) {
    try {
      permisosEfectivos = await api("/permisos/mias");
    } catch (e) {
      permisosEfectivos = {};
    }
  } else {
    permisosEfectivos = {};
  }

  document.querySelectorAll("[data-permiso], [data-permiso-any]").forEach((el) => {
    let permitido = esAdmin;
    if (!esAdmin) {
      if (el.dataset.permiso) {
        permitido = !!permisosEfectivos[el.dataset.permiso];
      } else if (el.dataset.permisoAny) {
        const claves = el.dataset.permisoAny.split(",").map((s) => s.trim()).filter(Boolean);
        permitido = claves.some((c) => !!permisosEfectivos[c]);
      }
    }
    el.style.display = permitido ? "" : "none";
  });

  // Oculta grupos cuyo toggle queda sin ningún sub-ítem visible.
  document.querySelectorAll(".nav-grupo").forEach((grupo) => {
    if (esAdmin) {
      grupo.style.display = "";
      return;
    }
    // Si el grupo ya se ocultó por data-permiso-any, no hay más que hacer.
    if (grupo.style.display === "none") return;
    const items = grupo.querySelectorAll(".nav-grupo-items .tab-btn");
    const algunoVisible = Array.from(items).some((b) => b.style.display !== "none");
    grupo.style.display = algunoVisible ? "" : "none";
  });

  // Oculta secciones del menú que no tienen ningún hijo visible
  // (así no queda el título "Reportes" o "Finanzas" vacío).
  document.querySelectorAll(".nav-seccion").forEach((seccion) => {
    if (seccion.classList.contains("solo-admin") && !esAdmin) {
      seccion.style.display = "none";
      return;
    }
    const hijos = seccion.querySelectorAll(":scope > .nav-grupo, :scope > .tab-btn");
    const alguno = Array.from(hijos).some((h) => h.style.display !== "none");
    // La sección Operación siempre tiene "Vender", que no se oculta.
    seccion.style.display = alguno ? "" : "none";
  });
}

function actualizarReloj() {
  const el = document.getElementById("reloj-topbar");
  if (!el) return;
  const ahora = new Date();
  el.textContent = ahora.toLocaleDateString("es-MX", { weekday: "short", day: "2-digit", month: "short" }) +
    "  " + ahora.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

document.getElementById("form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("login-username").value;
  const password = document.getElementById("login-password").value;
  try {
    const res = await fetch(API + "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "No se pudo iniciar sesión");

    sesion.token = data.token;
    sesion.usuario = data.usuario;
    localStorage.setItem("pos_token", data.token);
    localStorage.setItem("pos_usuario", JSON.stringify(data.usuario));
    document.getElementById("form-login").reset();
    mostrarApp();
  } catch (err) {
    toast(err.message, true);
  }
});


// ---------------------------------------------------------
// Modal de confirmación (reemplaza window.confirm nativo)
// ---------------------------------------------------------
function confirmarAccion({
  titulo = "Confirmar",
  mensaje = "¿Deseas continuar?",
  textoAceptar = "Aceptar",
  textoCancelar = "Cancelar",
  peligro = false,
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.getElementById("modal-confirmar");
    const box = overlay.querySelector(".modal-box");
    const btnAceptar = document.getElementById("modal-confirmar-aceptar");
    const btnCancelar = document.getElementById("modal-confirmar-cancelar");

    document.getElementById("modal-confirmar-titulo").textContent = titulo;
    document.getElementById("modal-confirmar-mensaje").textContent = mensaje;
    btnAceptar.textContent = textoAceptar;
    btnCancelar.textContent = textoCancelar;
    box.classList.toggle("modal-confirm-peligro", !!peligro);
    document.getElementById("modal-confirmar-icono").textContent = peligro ? "!" : "?";

    overlay.style.display = "flex";

    const cerrar = (valor) => {
      overlay.style.display = "none";
      btnAceptar.removeEventListener("click", onAceptar);
      btnCancelar.removeEventListener("click", onCancelar);
      overlay.removeEventListener("click", onOverlay);
      document.removeEventListener("keydown", onKey);
      resolve(valor);
    };
    const onAceptar = () => cerrar(true);
    const onCancelar = () => cerrar(false);
    const onOverlay = (e) => { if (e.target === overlay) cerrar(false); };
    const onKey = (e) => {
      if (e.key === "Escape") cerrar(false);
      if (e.key === "Enter") cerrar(true);
    };

    btnAceptar.addEventListener("click", onAceptar);
    btnCancelar.addEventListener("click", onCancelar);
    overlay.addEventListener("click", onOverlay);
    document.addEventListener("keydown", onKey);
    btnAceptar.focus();
  });
}

document.getElementById("btn-logout").addEventListener("click", async () => {
  const ok = await confirmarAccion({
    titulo: "Cerrar sesión",
    mensaje: "¿Deseas cerrar la sesión?",
    textoAceptar: "Sí, cerrar sesión",
    textoCancelar: "Cancelar",
    peligro: true,
  });
  if (!ok) return;
  try {
    await api("/auth/logout", { method: "POST" });
  } catch (e) {
    /* aunque falle en el servidor, cerramos sesión localmente */
  }
  cerrarSesionLocal();
});

function cerrarSesionLocal() {
  sesion = { token: null, usuario: null };
  localStorage.removeItem("pos_token");
  localStorage.removeItem("pos_usuario");
  carrito = [];
  if (window._intervalNotificaciones) {
    clearInterval(window._intervalNotificaciones);
    window._intervalNotificaciones = null;
  }
  _notificaciones = [];
  _clavesYaAvisadas = new Set();
  mostrarLogin();
}

// ---------------------------------------------------------
// Navegación por pestañas
// ---------------------------------------------------------
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
    document.getElementById("topbar-title").textContent = btn.dataset.titulo || btn.textContent.trim();

    if (btn.dataset.tab === "venta") {
      const b = document.getElementById("buscar-venta-rapida");
      if (b) { b.focus(); if (b.value.trim()) filtrarVentaRapida(b.value); }
    }
    if (btn.dataset.tab === "productos") cargarProveedoresSelects();
    if (btn.dataset.tab === "catalogo") { cargarProductos(); cargarProveedoresSelects(); }
    if (btn.dataset.tab === "lista-proveedores") cargarProveedores();
    if (btn.dataset.tab === "inventario") cargarProductosSinCodigoInventario();
    if (btn.dataset.tab === "movimientos") cargarMovimientos();
    if (btn.dataset.tab === "alertas-stock") cargarBajoStock();
    if (btn.dataset.tab === "notificaciones") {
      cargarResumenDia();
      cargarNotificaciones();
    }
    if (btn.dataset.tab === "ver-gastos") cargarOtrosGastos();
    if (btn.dataset.tab === "corte-caja") cargarCorteCaja();
    if (btn.dataset.tab === "reportes") cargarReportes();
    if (btn.dataset.tab === "usuarios") cargarUsuarios();
    if (btn.dataset.tab === "permisos") cargarPermisos();
    if (btn.dataset.tab === "configuracion") cargarConfiguracionAdmin();

    // Si llegó un código desde el celular mientras estabas en otra
    // pestaña (ej. Catálogo), al entrar a Vender/Agregar producto/
    // Inventario se aplica solo, sin tener que volver a escanear.
    aplicarCodigoRemotoSiCorresponde();
  });
});

// ---------------------------------------------------------
// Escaneo remoto: recibe en la computadora los códigos que se escanean
// desde la página /escanear del celular (misma cuenta logueada en
// ambos). Se revisa cada 1.2s mientras la sesión esté activa; en cuanto
// llega uno, se aplica en el lugar correcto según dónde estés parado:
// Vender -> se agrega al carrito; Agregar producto -> llena el código;
// Agregar inventario -> busca el producto para el movimiento.
// ---------------------------------------------------------
// Puede ser string (código solo, compat) o { codigo_barras, cantidad? }.
let _codigoRemotoPendiente = null;

async function revisarEscaneoRemoto() {
  if (!sesion.token) return;
  try {
    const d = await api("/escaneo-remoto/pendiente");
    if (d && d.codigo_barras) {
      _codigoRemotoPendiente = {
        codigo_barras: d.codigo_barras,
        cantidad: d.cantidad != null && d.cantidad > 0 ? Number(d.cantidad) : null,
      };
      aplicarCodigoRemotoSiCorresponde();
    }
  } catch (e) {
    // Silencioso: si falla un poll no bloqueamos el resto del sistema.
  }
}

function aplicarCodigoRemotoSiCorresponde() {
  if (!_codigoRemotoPendiente) return;
  const pendiente = typeof _codigoRemotoPendiente === "string"
    ? { codigo_barras: _codigoRemotoPendiente, cantidad: null }
    : _codigoRemotoPendiente;
  const codigo = pendiente.codigo_barras;
  const cantidad = pendiente.cantidad;
  const tabActiva = document.querySelector(".tab-btn.active")?.dataset.tab;

  if (tabActiva === "venta") {
    _codigoRemotoPendiente = null;
    if (cantidad != null && cantidad > 0) {
      // Cantidad ya capturada en el celular: se agrega directo al carrito.
      agregarAlCarritoConCantidad(codigo, cantidad);
    } else {
      agregarAlCarritoPorCodigo(codigo); // modal de cantidad en PC si es granel
    }
  } else if (tabActiva === "productos") {
    _codigoRemotoPendiente = null;
    document.getElementById("prod-codigo").value = codigo;
    autocompletarDesdeEscaneo(codigo);
    toast(`Código recibido desde el celular: ${codigo}`);
  } else if (tabActiva === "inventario") {
    _codigoRemotoPendiente = null;
    document.getElementById("inv-codigo").value = codigo;
    buscarProductoParaInventario(codigo);
    toast(`Código recibido desde el celular: ${codigo}`);
  } else {
    // Estás en una pestaña donde el código no aplica (Catálogo, Reportes,
    // etc.): se queda en espera y se usa solo en cuanto entres a Vender,
    // Agregar producto o Agregar inventario.
    toast(`Código escaneado desde el celular (${codigo}): ve a Vender, Agregar producto o Agregar inventario para usarlo`, true);
  }
}

/** Agrega al carrito con una cantidad ya definida (viene del celular). */
async function agregarAlCarritoConCantidad(codigo, cantidad) {
  ocultarAlertaNoEncontrado();
  try {
    const producto = await api(`/productos/codigo/${encodeURIComponent(codigo)}`);
    if (!producto.activo) {
      toast("Ese producto está dado de baja", true);
      return;
    }
    if (!cantidad || cantidad <= 0) {
      toast("Cantidad inválida recibida del celular", true);
      return;
    }
    if (producto.stock != null && cantidad > producto.stock) {
      toast(
        `No hay suficiente stock de "${producto.nombre}" (disponible: ${formatearCantidad(producto.stock, producto.unidad_venta)})`,
        true
      );
      return;
    }

    const existente = carrito.find((i) => i.codigo_barras === codigo);
    if (existente) {
      const nueva = existente.cantidad + cantidad;
      if (producto.stock != null && nueva > producto.stock) {
        toast(
          `No hay suficiente stock de "${producto.nombre}" (disponible: ${formatearCantidad(producto.stock, producto.unidad_venta)})`,
          true
        );
        return;
      }
      existente.cantidad = nueva;
      existente.stock = producto.stock;
    } else {
      carrito.push({
        codigo_barras: producto.codigo_barras,
        nombre: producto.nombre,
        precio: producto.precio_venta,
        cantidad,
        stock: producto.stock,
        unidad_venta: producto.unidad_venta || "pieza",
      });
    }
    renderCarrito();
    sonidoBeepEscaneo();
    toast(`${producto.nombre} × ${formatearCantidad(cantidad, producto.unidad_venta)} agregado`);
    const buscador = document.getElementById("buscar-venta-rapida");
    if (buscador) { buscador.value = ""; buscador.focus(); filtrarVentaRapida(""); }
  } catch (e) {
    if (e.message.includes("no encontrado") || e.message.includes("Producto no")) {
      mostrarAlertaNoEncontrado(codigo);
    } else {
      toast(e.message, true);
    }
  }
}

if (!window._intervalEscaneoRemoto) {
  window._intervalEscaneoRemoto = setInterval(revisarEscaneoRemoto, 1200);
}


// ---------------------------------------------------------
// Grupos desplegables del menú (Productos, Inventario, Proveedores, Gastos)
// ---------------------------------------------------------
document.querySelectorAll(".nav-grupo-toggle").forEach((toggle) => {
  toggle.addEventListener("click", () => {
    const items = document.getElementById(toggle.dataset.grupo);
    const yaAbierto = toggle.classList.contains("abierto");
    toggle.classList.toggle("abierto", !yaAbierto);
    items.classList.toggle("abierto", !yaAbierto);
  });
});

// ---------------------------------------------------------
// Escáner de código de barras (usa la cámara del celular)
// ---------------------------------------------------------
// El overlay (.lector-overlay) se muestra fijo y centrado en la pantalla
// -ya no queda "hasta abajo" del contenido de la página-.
//
// Para la lectura en sí se usa BarcodeDetector, pero SOLO sobre el
// recuadro guía que se ve en pantalla (no sobre el cuadro completo de la
// cámara). Analizar la imagen completa es justo lo que hacía que antes
// costara trabajo leer:
//   1) Es más lento: mientras más grande la imagen, más tarda el motor
//      (sobre todo el polyfill en WASM que usa iPhone/Safari) en
//      encontrar y decodificar el código.
//   2) Es menos preciso: un código de barras chico dentro de una foto
//      grande queda muy poco nítido para el decodificador, y si hay
//      varios códigos a la vista (etiquetas del anaquel, otro producto)
//      es más fácil que agarre el que no es.
// Al recortar solo el recuadro guía y usarlo "acercado" (zoom digital),
// el mismo código ocupa muchos más píxeles y el análisis es sobre una
// imagen mucho más chica: lee más rápido y más limpio. Esto es lo mismo
// que hacen las librerías rápidas de escaneo (como la que se usaba en
// WordPress): no leen la foto completa, leen solo el recuadro.
// El script "barcode-detector" cargado en index.html garantiza que esta
// función exista igual en Android, iPhone y cualquier navegador (ver
// comentario más abajo).
const FORMATOS_CODIGO_BARRAS = [
  "ean_13", "ean_8", "upc_a", "upc_e",
  "code_128", "code_39", "code_93", "codabar", "itf", "qr_code",
];

// Debe coincidir con el tamaño del recuadro guía dibujado en CSS
// (.lector-video-wrap::after: width 70%, height 32%). Si cambias uno,
// cambia el otro para que el recorte sea justo lo que el usuario ve.
const RECUADRO_GUIA_ANCHO = 0.70;
const RECUADRO_GUIA_ALTO = 0.32;

// El script "barcode-detector" (polyfill) cargado en index.html garantiza
// que window.BarcodeDetector exista en TODOS los navegadores: si el
// celular ya lo trae de fábrica (la mayoría de Android/Chrome), lo usa
// directo; si no (iPhone/Safari, navegadores viejos), lo rellena con el
// mismo motor pero corriendo en WebAssembly. Así el escaneo es igual de
// rápido en cualquier equipo, sin necesitar una librería de respaldo.
function iniciarEscaner(readerId, onResultado) {
  const el = document.getElementById(readerId);
  const overlay = document.getElementById(readerId + "-overlay");
  const yaAbierto = overlay.classList.contains("mostrar");
  if (yaAbierto) {
    detenerEscaner(readerId);
    return;
  }
  overlay.classList.add("mostrar");

  const terminar = (codigo) => {
    detenerEscaner(readerId);
    onResultado(codigo);
  };

  iniciarLectorNativo(el, terminar);
}

function detenerEscaner(readerId) {
  const el = document.getElementById(readerId);
  const overlay = document.getElementById(readerId + "-overlay");
  overlay.classList.remove("mostrar");
  if (el._detener) {
    el._detener();
    el._detener = null;
  }
}

// Lector rápido con la API nativa del navegador (BarcodeDetector).
function iniciarLectorNativo(el, onResultado) {
  el.innerHTML = "";
  const video = document.createElement("video");
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");
  video.muted = true;
  el.appendChild(video);

  // Canvas oculto: aquí se dibuja, en cada cuadro, SOLO el recorte que
  // corresponde al recuadro guía (ver RECUADRO_GUIA_ANCHO/ALTO), y es
  // esa imagen chica -no el video completo- la que se manda a decodificar.
  const canvasRecorte = document.createElement("canvas");
  const ctxRecorte = canvasRecorte.getContext("2d", { willReadFrequently: true });

  let detenido = false;
  let stream = null;
  const detector = new BarcodeDetector({ formats: FORMATOS_CODIGO_BARRAS });

  el._detener = () => {
    detenido = true;
    if (stream) stream.getTracks().forEach((t) => t.stop());
  };

  navigator.mediaDevices
    .getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        // Pedimos la mayor resolución posible: como solo se procesa el
        // recorte del recuadro guía (una fracción de la imagen), aquí sí
        // conviene partir de un video bien detallado -el recorte sale
        // más nítido y el código se lee mejor, sin pagar el costo en
        // velocidad porque nunca se decodifica el cuadro completo.
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    })
    .then((s) => {
      stream = s;
      video.srcObject = s;
      video.play();

      const [pista] = s.getVideoTracks();
      const capacidades = pista.getCapabilities ? pista.getCapabilities() : {};

      // Enfoque continuo: sin esto, muchos Android dejan la cámara con
      // foco fijo y el código de barras nunca queda nítido de cerca.
      if (capacidades.focusMode && capacidades.focusMode.includes("continuous")) {
        pista.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
      }
      // Linterna, si el equipo la soporta (ayuda mucho con poca luz).
      if (capacidades.torch) {
        mostrarBotonLinterna(el, pista);
      }
      // Zoom óptico/digital del propio celular, si lo soporta: acerca
      // aún más el recuadro guía al código, mucho más nítido que hacer
      // zoom por software con el canvas.
      if (capacidades.zoom && capacidades.zoom.max > capacidades.zoom.min) {
        mostrarBotonZoom(el, pista, capacidades.zoom);
      }

      // Evita falsos positivos: exige el mismo código 2 veces seguidas
      // antes de darlo por bueno (una lectura suelta, por movimiento o
      // por agarrar de refilón otro código, no se cuela). Como ahora la
      // detección es mucho más rápida (imagen chica), esto sigue siendo
      // casi instantáneo para el usuario.
      let ultimoCandidato = null;
      let vecesSeguidas = 0;

      const detectarCuadro = () => {
        if (detenido) return;
        if (!video.videoWidth) {
          // El video aún no tiene dimensiones (primer(os) cuadro(s)).
          requestAnimationFrame(detectarCuadro);
          return;
        }

        // Recorta exactamente el área del recuadro guía, en coordenadas
        // reales del video (no de la pantalla), y la agranda al tamaño
        // del canvas: es el efecto "zoom" que hace que el código se lea
        // mucho más rápido y sin errores que analizando el video entero.
        const anchoRecorte = video.videoWidth * RECUADRO_GUIA_ANCHO;
        const altoRecorte = video.videoHeight * RECUADRO_GUIA_ALTO;
        const xRecorte = (video.videoWidth - anchoRecorte) / 2;
        const yRecorte = (video.videoHeight - altoRecorte) / 2;

        // Si el recorte sale chico (cámara con poca resolución real),
        // lo agrandamos más al dibujarlo para darle al decodificador
        // suficientes píxeles por barra. Si ya sale grande, no hace
        // falta agrandar más (sería trabajo extra sin beneficio).
        const escala = Math.min(3, Math.max(1, 900 / anchoRecorte));
        canvasRecorte.width = Math.round(anchoRecorte * escala);
        canvasRecorte.height = Math.round(altoRecorte * escala);
        ctxRecorte.imageSmoothingEnabled = escala <= 1; // nítido al agrandar
        ctxRecorte.drawImage(
          video,
          xRecorte, yRecorte, anchoRecorte, altoRecorte,
          0, 0, canvasRecorte.width, canvasRecorte.height
        );

        detector
          .detect(canvasRecorte)
          .then((codigos) => {
            if (detenido) return;

            // Descarta lecturas cuyo dígito verificador (checksum) no
            // cuadra: un código mal leído casi nunca da un checksum válido.
            const validos = codigos.filter((c) => checksumEanUpcValido(c.rawValue));
            if (validos.length === 0) {
              vecesSeguidas = 0;
              requestAnimationFrame(detectarCuadro);
              return;
            }

            // Ya casi nunca hay más de un código dentro del recuadro
            // recortado, pero por si acaso, prioriza el más cercano al
            // centro (normalmente es al que le apuntas).
            const cx = canvasRecorte.width / 2;
            const cy = canvasRecorte.height / 2;
            validos.sort(
              (a, b) => distanciaAlCentro(a, cx, cy) - distanciaAlCentro(b, cx, cy)
            );
            const elegido = validos[0];

            if (elegido.rawValue === ultimoCandidato) {
              vecesSeguidas++;
            } else {
              ultimoCandidato = elegido.rawValue;
              vecesSeguidas = 1;
            }

            if (vecesSeguidas >= 2) {
              onResultado(elegido.rawValue);
              return;
            }
            requestAnimationFrame(detectarCuadro);
          })
          .catch(() => {
            if (!detenido) requestAnimationFrame(detectarCuadro);
          });
      };
      requestAnimationFrame(detectarCuadro);
    })
    .catch((err) => {
      toast("No se pudo acceder a la cámara: " + err, true);
      detenerEscaner(el.id);
    });
}

// Distancia (al cuadrado, no hace falta la raíz) del centro de un código
// detectado al centro de la imagen analizada. Si el navegador no da
// boundingBox, se trata como si estuviera en el centro (no penaliza).
function distanciaAlCentro(codigo, cx, cy) {
  const caja = codigo.boundingBox;
  if (!caja) return 0;
  const codX = caja.x + caja.width / 2;
  const codY = caja.y + caja.height / 2;
  return (codX - cx) ** 2 + (codY - cy) ** 2;
}

// Valida el dígito verificador de códigos EAN-13, EAN-8 y UPC-A (los
// formatos numéricos típicos de productos). Los demás formatos (QR,
// Code128, etc.) ya traen su propia verificación interna al decodificar,
// así que se dejan pasar sin más.
function checksumEanUpcValido(codigo) {
  if (!/^\d{8}$|^\d{12}$|^\d{13}$/.test(codigo)) return true;
  const cuerpo = codigo.slice(0, -1).split("").map(Number);
  const checkEsperado = Number(codigo.slice(-1));
  let suma = 0;
  cuerpo.forEach((d, i) => {
    const posDesdeDerecha = cuerpo.length - i;
    suma += d * (posDesdeDerecha % 2 === 1 ? 3 : 1);
  });
  const checkCalculado = (10 - (suma % 10)) % 10;
  return checkCalculado === checkEsperado;
}

// Botón de linterna dentro del recuadro de la cámara (solo si el equipo
// la soporta). Ayuda mucho a leer el código cuando hay poca luz.
function mostrarBotonLinterna(el, pista) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "lector-linterna";
  btn.textContent = "🔦";
  btn.setAttribute("aria-label", "Encender/apagar linterna");
  let encendida = false;
  btn.addEventListener("click", () => {
    encendida = !encendida;
    pista.applyConstraints({ advanced: [{ torch: encendida }] }).catch(() => {});
    btn.classList.toggle("activa", encendida);
  });
  el.appendChild(btn);
}

// Botón de zoom dentro del recuadro de la cámara (solo si el equipo lo
// soporta). Acercar el código con el zoom del propio celular ayuda mucho
// más que solo confiar en el recorte por software, sobre todo con
// códigos chicos o de lejos.
function mostrarBotonZoom(el, pista, zoomCap) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "lector-zoom";
  btn.textContent = "🔍";
  btn.setAttribute("aria-label", "Acercar/alejar zoom");
  // Nivel de acercamiento moderado: suficiente para códigos chicos, sin
  // pasarse al punto de que cueste mantenerlo encuadrado con la mano.
  const nivelAcercado = Math.min(zoomCap.max, Math.max(zoomCap.min * 1, 2));
  let acercado = false;
  btn.addEventListener("click", () => {
    acercado = !acercado;
    const valor = acercado ? nivelAcercado : zoomCap.min;
    pista.applyConstraints({ advanced: [{ zoom: valor }] }).catch(() => {});
    btn.classList.toggle("activa", acercado);
  });
  el.appendChild(btn);
}

document.querySelectorAll("[data-cerrar-lector]").forEach((btn) => {
  btn.addEventListener("click", () => detenerEscaner(btn.dataset.cerrarLector));
});

/**
 * Detecta cuando el usuario terminó de ingresar un código de barras en un
 * input -ya sea con un lector físico (que "teclea" el código muy rápido y
 * casi siempre remata con Enter) o escribiéndolo a mano- y dispara un
 * callback automáticamente, sin necesitar dar clic en ningún botón.
 * Se activa por:
 *   - Tecla Enter (así funcionan casi todos los lectores USB/Bluetooth).
 *   - Una pausa breve después de dejar de teclear (cubre lectores que no
 *     mandan Enter, y también cuando el código se escribe a mano).
 */
function activarAutoDeteccion(inputEl, callback, pausaMs = 400) {
  let temporizador = null;
  const disparar = () => {
    clearTimeout(temporizador);
    const valor = inputEl.value.trim();
    if (valor) callback(valor);
  };
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      disparar();
    }
  });
  inputEl.addEventListener("input", () => {
    clearTimeout(temporizador);
    temporizador = setTimeout(disparar, pausaMs);
  });
}

document.getElementById("btn-scan").addEventListener("click", () => {
  iniciarEscaner("reader", (codigo) => agregarAlCarritoPorCodigo(codigo));
});
document.getElementById("btn-scan-alta").addEventListener("click", () => {
  iniciarEscaner("reader-alta", (codigo) => autocompletarDesdeEscaneo(codigo));
});

/**
 * Al escanear un código en el alta/edición de producto:
 * 1) Rellena el campo de código.
 * 2) Si es un producto nuevo (no estamos editando uno existente) y el
 *    nombre está vacío, busca el código en internet (Open Food/Beauty/
 *    Products Facts) y, si lo encuentra, autocompleta nombre y categoría
 *    para que solo falte revisar y poner el precio.
 * Si no hay internet o el código no aparece en ninguna fuente, no pasa
 * nada más y se sigue con el alta 100% manual.
 */
async function autocompletarDesdeEscaneo(codigo) {
  document.getElementById("prod-codigo").value = codigo;

  const esEdicion = !!document.getElementById("prod-id").value;
  const nombreInput = document.getElementById("prod-nombre");
  const categoriaInput = document.getElementById("prod-categoria");
  if (esEdicion || nombreInput.value.trim()) return; // no pisamos datos ya cargados

  try {
    const resultado = await api(`/productos/buscar-web/${encodeURIComponent(codigo)}`);
    if (resultado.encontrado) {
      nombreInput.value = resultado.nombre;
      if (resultado.categoria && !categoriaInput.value) categoriaInput.value = resultado.categoria;
      toast(`Nombre autocompletado desde internet: ${resultado.nombre}`);
    }
  } catch (e) {
    // Sin internet u otra falla: no interrumpe el alta manual.
  }
}
// También autocompleta el nombre por internet si el código se teclea a mano
// (no solo al escanearlo con la cámara).
activarAutoDeteccion(document.getElementById("prod-codigo"), (codigo) => {
  autocompletarDesdeEscaneo(codigo);
});

document.getElementById("btn-scan-inv").addEventListener("click", () => {
  iniciarEscaner("reader-inv", (codigo) => {
    document.getElementById("inv-codigo").value = codigo;
    buscarProductoParaInventario(codigo);
  });
});

// Al escanear o teclear el código en Inventario, busca el producto y muestra
// sus datos (nombre, categoría, stock actual) para confirmar que es el
// correcto antes de registrar el movimiento.
activarAutoDeteccion(document.getElementById("inv-codigo"), (codigo) => {
  buscarProductoParaInventario(codigo);
});

async function buscarProductoParaInventario(codigo) {
  const caja = document.getElementById("inv-producto-info");
  if (!codigo) {
    caja.style.display = "none";
    return;
  }
  try {
    const producto = await api(`/productos/codigo/${encodeURIComponent(codigo)}`);
    document.getElementById("inv-info-nombre").value =
      producto.nombre + (producto.activo ? "" : "  (dado de baja)");
    document.getElementById("inv-info-categoria").value = producto.categoria || "General";
    document.getElementById("inv-info-stock-actual").value = `${formatearCantidad(producto.stock, producto.unidad_venta)} en stock`;
    caja.style.display = "block";
    // Refleja el producto en el buscador global (útil tras escanear).
    const buscador = document.getElementById("inv-buscar-sin-codigo");
    if (buscador) {
      buscador.value = producto.nombre;
      document.getElementById("inv-limpiar-sin-codigo").style.display = "inline-block";
      document.getElementById("inv-lista-sin-codigo").style.display = "none";
    }
    document.getElementById("inv-codigo").value = producto.codigo_barras;

    // Se precarga el costo con el que ya tiene registrado el producto (el
    // que se capturó al darlo de alta o en la última entrada), para que el
    // cajero no tenga que volver a teclearlo cada vez. Sigue siendo
    // editable por si esta compra en particular cambió de precio.
    document.getElementById("inv-costo-unitario").value =
      producto.costo != null && producto.costo > 0 ? producto.costo.toFixed(2) : "";

    // Si el producto se vende a granel, la cantidad del movimiento se
    // captura en kilogramos con decimales (ej. 2.500); si es por pieza,
    // se mantiene en números enteros.
    const esKg = producto.unidad_venta === "kg";
    const inputCantidad = document.getElementById("inv-cantidad");
    inputCantidad.step = esKg ? "0.001" : "1";
    inputCantidad.placeholder = esKg ? "Cantidad en kg *" : "Cantidad *";
  } catch (e) {
    caja.style.display = "none";
    toast(`Código "${codigo}" no encontrado`, true);
  }
}

document.getElementById("inv-codigo").addEventListener("input", (e) => {
  if (!e.target.value.trim()) document.getElementById("inv-producto-info").style.display = "none";
  // Si el cajero ya está escribiendo un código de barras a mano, se limpia
  // cualquier selección previa del buscador por nombre para no mezclar ambas
  // fuentes.
  _limpiarSeleccionSinCodigo({ limpiarCodigo: false });
  e.target.readOnly = false;
});

// ---- Buscador global de productos (inventario) ----
// Mismo criterio que en Vender: busca por nombre o código en todo el
// catálogo activo (con código de barras y sin él).
let _catalogoInventario = [];

async function cargarProductosSinCodigoInventario() {
  // Nombre histórico de la función (la llama el cambio de pestaña);
  // ahora carga el catálogo completo.
  try {
    _catalogoInventario = await api("/productos?activos=true");
  } catch (e) {
    _catalogoInventario = [];
  }
}

function _filtrarCatalogoInventario(texto) {
  const termino = normalizarTexto((texto || "").trim());
  if (!termino) return [];
  return _catalogoInventario.filter((p) =>
    normalizarTexto(p.nombre).includes(termino) ||
    normalizarTexto(p.codigo_barras || "").includes(termino)
  ).slice(0, 15);
}

function _renderListaSinCodigoInventario(productos) {
  const lista = document.getElementById("inv-lista-sin-codigo");
  lista.innerHTML = "";

  if (productos.length === 0) {
    lista.innerHTML = `<p class="combo-sin-resultados">Sin resultados</p>`;
    lista.style.display = "block";
    return;
  }

  productos.forEach((p) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "combo-item";
    const precioTexto = p.unidad_venta === "kg" ? `$${p.precio_venta.toFixed(2)}/kg` : `$${p.precio_venta.toFixed(2)}`;
    const extra = p.unidad_venta === "kg" ? " (a granel)" : (p.requiere_codigo === false ? "" : "");
    item.innerHTML = `<span>${p.nombre}${extra}</span><span class="precio-rapido">${precioTexto}</span>`;
    item.addEventListener("click", () => _seleccionarProductoSinCodigo(p));
    lista.appendChild(item);
  });
  lista.style.display = "block";
}

function _seleccionarProductoSinCodigo(producto) {
  const inputCodigo = document.getElementById("inv-codigo");
  const buscador = document.getElementById("inv-buscar-sin-codigo");

  // El código (real o interno INT-XXXX) viaja oculto para el backend;
  // el cajero confirma el producto por el nombre en pantalla.
  inputCodigo.value = producto.codigo_barras;
  inputCodigo.readOnly = true;
  buscador.value = producto.nombre;
  document.getElementById("inv-lista-sin-codigo").style.display = "none";
  document.getElementById("inv-limpiar-sin-codigo").style.display = "inline-block";
  buscarProductoParaInventario(producto.codigo_barras);
}

function _limpiarSeleccionSinCodigo({ limpiarCodigo = true } = {}) {
  document.getElementById("inv-buscar-sin-codigo").value = "";
  document.getElementById("inv-lista-sin-codigo").style.display = "none";
  document.getElementById("inv-limpiar-sin-codigo").style.display = "none";
  if (limpiarCodigo) {
    const inputCodigo = document.getElementById("inv-codigo");
    inputCodigo.value = "";
    inputCodigo.readOnly = false;
    document.getElementById("inv-producto-info").style.display = "none";
  }
}

document.getElementById("inv-buscar-sin-codigo").addEventListener("input", (e) => {
  document.getElementById("inv-limpiar-sin-codigo").style.display = "none";
  const crudo = e.target.value.trim();
  if (!crudo) {
    document.getElementById("inv-lista-sin-codigo").style.display = "none";
    return;
  }
  _renderListaSinCodigoInventario(_filtrarCatalogoInventario(crudo));
});

document.getElementById("inv-buscar-sin-codigo").addEventListener("focus", (e) => {
  const crudo = e.target.value.trim();
  if (crudo) {
    _renderListaSinCodigoInventario(_filtrarCatalogoInventario(crudo));
  }
});

// Enter: si hay un solo resultado o coincide el código exacto, seleccionarlo.
document.getElementById("inv-buscar-sin-codigo").addEventListener("keydown", (e) => {
  if (e.key !== "Enter") return;
  e.preventDefault();
  const crudo = e.target.value.trim();
  if (!crudo) return;
  const exacto = _catalogoInventario.find(
    (p) => (p.codigo_barras || "").toLowerCase() === crudo.toLowerCase()
  );
  if (exacto) {
    _seleccionarProductoSinCodigo(exacto);
    return;
  }
  const filtrados = _filtrarCatalogoInventario(crudo);
  if (filtrados.length === 1) {
    _seleccionarProductoSinCodigo(filtrados[0]);
  } else if (filtrados.length === 0) {
    toast("No se encontró ese producto", true);
  } else {
    _renderListaSinCodigoInventario(filtrados);
    toast(`Hay ${filtrados.length} resultados: elige uno`);
  }
});

document.getElementById("inv-limpiar-sin-codigo").addEventListener("click", () => {
  _limpiarSeleccionSinCodigo();
});

// Cierra la lista de sugerencias al hacer clic fuera del buscador.
document.addEventListener("click", (e) => {
  const combo = document.getElementById("inv-combo-sin-codigo");
  if (combo && !combo.contains(e.target)) {
    document.getElementById("inv-lista-sin-codigo").style.display = "none";
  }
});

// ---------------------------------------------------------
// VENTA / CARRITO
// ---------------------------------------------------------
async function agregarAlCarritoPorCodigo(codigo) {
  ocultarAlertaNoEncontrado();
  try {
    const producto = await api(`/productos/codigo/${encodeURIComponent(codigo)}`);
    if (!producto.activo) {
      toast("Ese producto está dado de baja", true);
      return;
    }

    // Productos a granel (se venden por peso): siempre se captura la
    // cantidad exacta en el diálogo, nunca se suma "+1" a lo tonto.
    if (producto.unidad_venta === "kg") {
      abrirModalCantidad(producto);
      return;
    }

    const existente = carrito.find((i) => i.codigo_barras === codigo);
    const cantidadDeseada = (existente ? existente.cantidad : 0) + 1;

    if (cantidadDeseada > producto.stock) {
      toast(`No hay suficiente stock de "${producto.nombre}" (disponible: ${producto.stock})`, true);
      return;
    }

    if (existente) {
      existente.cantidad += 1;
      existente.stock = producto.stock; // refresca el stock conocido
    } else {
      carrito.push({
        codigo_barras: producto.codigo_barras,
        nombre: producto.nombre,
        precio: producto.precio_venta,
        cantidad: 1,
        stock: producto.stock,
        unidad_venta: producto.unidad_venta || "pieza",
      });
    }
    renderCarrito();
    sonidoBeepEscaneo();
    toast(`${producto.nombre} agregado`);
    const buscador = document.getElementById("buscar-venta-rapida");
    if (buscador) { buscador.value = ""; buscador.focus(); filtrarVentaRapida(""); }
  } catch (e) {
    if (e.message.includes("no encontrado") || e.message.includes("Producto no")) {
      mostrarAlertaNoEncontrado(codigo);
    } else {
      toast(e.message, true);
    }
  }
}

// --- Flujo de "producto no encontrado" -> alta rápida desde el mismo escaneo ---
async function mostrarAlertaNoEncontrado(codigo) {
  ultimoCodigoNoEncontrado = codigo;
  const panel = document.getElementById("alerta-no-encontrado");
  const texto = document.getElementById("texto-no-encontrado");
  const formRapido = document.getElementById("form-alta-rapida");
  panel.style.display = "block";

  if (tienePermiso("productos.agregar")) {
    texto.textContent = `El código "${codigo}" no está registrado. Buscando en internet...`;
    document.getElementById("rapido-codigo").value = codigo;
    document.getElementById("rapido-nombre").value = "";
    document.getElementById("rapido-precio").value = "";
    document.getElementById("rapido-stock").value = 1;
    formRapido.style.display = "block";

    // Método 2: intenta autocompletar consultando bases de datos web
    // (Open Food/Beauty/Products Facts). Si no hay internet o el
    // código no aparece, simplemente no rellena nada y se sigue con
    // el alta 100% manual (el escaneo local no depende de esto).
    try {
      const resultado = await api(`/productos/buscar-web/${encodeURIComponent(codigo)}`);
      if (resultado.encontrado) {
        document.getElementById("rapido-nombre").value = resultado.nombre;
        texto.textContent = `El código "${codigo}" no está registrado. Encontramos este producto en internet, revisa el nombre y completa el precio:`;
      } else {
        texto.textContent = `El código "${codigo}" no está registrado y no lo encontramos en internet. Dalo de alta manualmente:`;
      }
    } catch (e) {
      // Sin conexión a internet u otra falla: seguimos con alta manual sin interrumpir la venta.
      texto.textContent = `El código "${codigo}" no está registrado (sin conexión a internet para buscarlo). Dalo de alta manualmente:`;
    }
  } else {
    texto.textContent = `El código "${codigo}" no está registrado. Pide a un administrador que lo dé de alta.`;
    formRapido.style.display = "none";
  }
}

function ocultarAlertaNoEncontrado() {
  document.getElementById("alerta-no-encontrado").style.display = "none";
}

document.getElementById("btn-cancelar-alta-rapida").addEventListener("click", ocultarAlertaNoEncontrado);

document.getElementById("form-alta-rapida").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {
    codigo_barras: document.getElementById("rapido-codigo").value,
    nombre: document.getElementById("rapido-nombre").value,
    precio_venta: parseFloat(document.getElementById("rapido-precio").value),
    stock: parseInt(document.getElementById("rapido-stock").value || 1),
  };
  try {
    await api("/productos", { method: "POST", body: JSON.stringify(payload) });
    toast("Producto dado de alta");
    ocultarAlertaNoEncontrado();
    agregarAlCarritoPorCodigo(payload.codigo_barras);
  } catch (err) {
    toast(err.message, true);
  }
});

// Agrega al carrito automáticamente en cuanto se escanea o se termina de
// teclear el código (Enter del lector, o pausa breve al escribir a mano).
const inputCodigoVenta = document.getElementById("input-codigo");
activarAutoDeteccion(inputCodigoVenta, (codigo) => {
  agregarAlCarritoPorCodigo(codigo);
  inputCodigoVenta.value = "";
});

function formatearCantidad(cantidad, unidadVenta) {
  if (unidadVenta === "kg") {
    return cantidad < 1 ? `${Math.round(cantidad * 1000)} g` : `${cantidad.toFixed(3)} kg`;
  }
  return String(cantidad);
}

function renderCarrito() {
  const tbody = document.querySelector("#tabla-carrito tbody");
  tbody.innerHTML = "";
  let total = 0;
  carrito.forEach((item, idx) => {
    const subtotal = item.precio * item.cantidad;
    total += subtotal;
    const esKg = item.unidad_venta === "kg";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${item.nombre}</td>
      <td>$${item.precio.toFixed(2)}${esKg ? "/kg" : ""}</td>
      <td>
        ${esKg
          ? `${formatearCantidad(item.cantidad, "kg")} <button class="link-btn" onclick="editarCantidadCarrito(${idx})">✎ Editar</button>`
          : `<button class="link-btn" onclick="cambiarCantidad(${idx}, -1)">−</button>
             ${item.cantidad}
             <button class="link-btn" onclick="cambiarCantidad(${idx}, 1)">+</button>`}
      </td>
      <td>$${subtotal.toFixed(2)}</td>
      <td><button class="link-btn danger" onclick="quitarDelCarrito(${idx})">✕</button></td>
    `;
    tbody.appendChild(tr);
  });
  document.getElementById("total-carrito").textContent = total.toFixed(2);
}

function cambiarCantidad(idx, delta) {
  const item = carrito[idx];
  if (delta > 0 && item.cantidad + delta > item.stock) {
    toast(`No hay suficiente stock de "${item.nombre}" (disponible: ${item.stock})`, true);
    return;
  }
  item.cantidad += delta;
  if (item.cantidad <= 0) carrito.splice(idx, 1);
  renderCarrito();
}
function quitarDelCarrito(idx) {
  carrito.splice(idx, 1);
  renderCarrito();
}

function editarCantidadCarrito(idx) {
  const item = carrito[idx];
  abrirModalCantidad(
    {
      nombre: item.nombre,
      precio_venta: item.precio,
      stock: item.stock,
      unidad_venta: item.unidad_venta,
      codigo_barras: item.codigo_barras,
    },
    idx
  );
}

// ---------------------------------------------------------
// VENTA: buscador global + atajos de los más vendidos (con y sin código)
// ---------------------------------------------------------

// Quita acentos y pasa a minúsculas para que la búsqueda funcione igual
// si el cajero escribe "huevo", "Huevo" o "HUÉVO".
function normalizarTexto(texto) {
  return (texto || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

// Top 9 más vendidos (todo el catálogo) + búsqueda por nombre/código.
const LIMITE_VENTA_RAPIDA = 9;
const LIMITE_BUSQUEDA_VENTA = 12;
let _catalogoVenta = [];   // catálogo activo completo (búsqueda)
let _topVentaRapida = [];  // 9 más vendidos (con y sin código)

async function cargarVentaRapida() {
  const grid = document.getElementById("grid-venta-rapida");
  try {
    const [todos, top] = await Promise.all([
      api("/productos?activos=true"),
      api(`/productos/venta-rapida?limite=${LIMITE_VENTA_RAPIDA}`),
    ]);
    _catalogoVenta = todos || [];
    _topVentaRapida = top || [];

    const busqueda = document.getElementById("buscar-venta-rapida");
    if (busqueda && busqueda.value.trim()) {
      filtrarVentaRapida(busqueda.value);
      return;
    }
    if (_topVentaRapida.length === 0 && _catalogoVenta.length === 0) {
      grid.innerHTML = `<p class="aviso-vacio-rapida">Aún no hay productos. Agrégalos desde Productos.</p>`;
      document.getElementById("aviso-sin-resultados-rapida").style.display = "none";
      const sub = document.getElementById("venta-rapida-subtitulo");
      if (sub) sub.style.display = "none";
      return;
    }
    renderGridVentaRapida(_topVentaRapida, { modo: "top" });
  } catch (e) {
    _catalogoVenta = [];
    _topVentaRapida = [];
    grid.innerHTML = "";
  }
}

function _agregarProductoDesdeVentaRapida(p) {
  // Al buscar/clickear un producto en la PC (venta rápida) siempre se abre
  // el modal de cantidad, sea granel, pieza con código o pieza sin código.
  // El "+1 directo" solo aplica cuando el código llega de un escaneo real
  // (lector USB, cámara o celular), vía agregarAlCarritoPorCodigo.
  abrirModalCantidad(p);
}

function renderGridVentaRapida(productos, { modo = "top" } = {}) {
  const grid = document.getElementById("grid-venta-rapida");
  const avisoSinResultados = document.getElementById("aviso-sin-resultados-rapida");
  const sub = document.getElementById("venta-rapida-subtitulo");
  grid.innerHTML = "";

  if (productos.length === 0) {
    if (modo === "busqueda") {
      avisoSinResultados.style.display = "block";
      if (sub) sub.style.display = "none";
    } else {
      avisoSinResultados.style.display = "none";
      if (sub) {
        sub.style.display = "";
        sub.textContent = "Escribe arriba para buscar cualquier producto";
      }
      grid.innerHTML = `<p class="aviso-vacio-rapida">No hay atajos de venta rápida todavía. Busca por nombre o escanea un código.</p>`;
    }
    return;
  }
  avisoSinResultados.style.display = "none";
  if (sub) {
    sub.style.display = "";
    if (modo === "busqueda") {
      sub.textContent = `${productos.length} resultado${productos.length === 1 ? "" : "s"}`;
    } else {
      sub.textContent = `Los ${productos.length} más vendidos`;
    }
  }

  productos.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-venta-rapida";
    const precioTexto = p.unidad_venta === "kg" ? `$${p.precio_venta.toFixed(2)}/kg` : `$${p.precio_venta.toFixed(2)}`;
    const marcaCodigo = p.requiere_codigo === false
      ? ""
      : `<span class="precio-rapido" style="opacity:0.65">· código</span>`;
    btn.innerHTML = `${p.nombre}${marcaCodigo}<span class="precio-rapido">${precioTexto}</span>`;
    btn.addEventListener("click", () => _agregarProductoDesdeVentaRapida(p));
    grid.appendChild(btn);
  });
}

function _resultadosBusquedaVenta(texto) {
  const termino = normalizarTexto((texto || "").trim());
  if (!termino) return [];
  return _catalogoVenta.filter((p) =>
    normalizarTexto(p.nombre).includes(termino) ||
    normalizarTexto(p.codigo_barras || "").includes(termino)
  );
}

function filtrarVentaRapida(texto) {
  const crudo = (texto || "").trim();
  if (!crudo) {
    renderGridVentaRapida(_topVentaRapida, { modo: "top" });
    return;
  }
  const filtrados = _resultadosBusquedaVenta(crudo).slice(0, LIMITE_BUSQUEDA_VENTA);
  renderGridVentaRapida(filtrados, { modo: "busqueda" });
}

function _pareceCodigoBarras(texto) {
  // Lectores y códigos típicos: solo dígitos (o internos INT-xxxx),
  // sin espacios, longitud razonable.
  const t = (texto || "").trim();
  if (t.length < 4) return false;
  if (/\s/.test(t)) return false;
  return /^[0-9]{6,}$/.test(t) || /^INT-[0-9A-F]+$/i.test(t);
}

async function resolverBusquedaVentaConEnter() {
  const input = document.getElementById("buscar-venta-rapida");
  const crudo = (input.value || "").trim();
  if (!crudo) return;

  // 1) Coincidencia exacta de código de barras
  const porCodigo = _catalogoVenta.find(
    (p) => (p.codigo_barras || "").toLowerCase() === crudo.toLowerCase()
  );
  if (porCodigo) {
    input.value = "";
    filtrarVentaRapida("");
    _agregarProductoDesdeVentaRapida(porCodigo);
    return;
  }

  // 2) Parece código de barras (lector USB): intentar como escaneo
  if (_pareceCodigoBarras(crudo)) {
    input.value = "";
    filtrarVentaRapida("");
    await agregarAlCarritoPorCodigo(crudo);
    return;
  }

  // 3) Un solo resultado por nombre → agregarlo
  const resultados = _resultadosBusquedaVenta(crudo);
  if (resultados.length === 1) {
    input.value = "";
    filtrarVentaRapida("");
    _agregarProductoDesdeVentaRapida(resultados[0]);
    return;
  }

  // 4) Varios o ninguno: dejar la lista filtrada visible
  if (resultados.length === 0) {
    toast("No se encontró ese producto", true);
  } else {
    toast(`Hay ${resultados.length} resultados: elige uno en la lista`);
  }
}

const inputBuscarVenta = document.getElementById("buscar-venta-rapida");
inputBuscarVenta.addEventListener("input", (e) => {
  filtrarVentaRapida(e.target.value);
});
inputBuscarVenta.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    resolverBusquedaVentaConEnter();
  }
});

let _productoModalCantidad = null;
let _idxEdicionCarrito = null;
// Unidad en la que el CAJERO está escribiendo la cantidad dentro del modal:
// "g" (gramos, para compras chicas como 100 g de jamón) o "kg" (kilos enteros
// o medios kilos). El carrito y el stock siempre se guardan en kilogramos por
// dentro; esto solo cambia cómo se ve/captura el número en pantalla.
let _unidadModalCantidad = "g";

// Convierte lo que hay en el input (en la unidad visible: g o kg) a kilogramos,
// que es la unidad que usa el resto del sistema (carrito, stock, backend).
function _cantidadEnKgDesdeInput() {
  const valor = parseFloat(document.getElementById("mcr-cantidad").value) || 0;
  return _unidadModalCantidad === "g" ? valor / 1000 : valor;
}

function abrirModalCantidad(producto, idxExistente = null) {
  _productoModalCantidad = producto;
  _idxEdicionCarrito = idxExistente;
  const esKg = producto.unidad_venta === "kg";

  document.getElementById("mcr-nombre").textContent = producto.nombre;
  document.getElementById("mcr-precio-label").textContent = esKg
    ? `Precio: $${producto.precio_venta.toFixed(2)} por kilogramo`
    : `Precio: $${producto.precio_venta.toFixed(2)} c/u`;

  const cantidadPreviaKg = idxExistente !== null ? carrito[idxExistente].cantidad : (esKg ? 0.1 : 1);

  document.getElementById("mcr-toggle-unidad").style.display = esKg ? "flex" : "none";
  if (esKg) {
    // Si ya trae medio kilo o más, es más natural mostrarlo en kilos;
    // si es menos de medio kilo, se ve y se escribe mejor en gramos.
    _unidadModalCantidad = cantidadPreviaKg >= 0.5 ? "kg" : "g";
    _configurarUnidadModalCantidad(cantidadPreviaKg);
  } else {
    _unidadModalCantidad = "pieza";
    document.getElementById("mcr-sufijo-unidad").textContent = "";
    const input = document.getElementById("mcr-cantidad");
    input.step = "1";
    input.min = "1";
    input.value = cantidadPreviaKg;
    document.getElementById("mcr-presets").innerHTML = "";
  }

  actualizarSubtotalModalCantidad();
  document.getElementById("modal-cantidad-rapida").style.display = "flex";
}

// Deja el input, el sufijo, los presets y los botones +/- listos según la
// unidad activa (gramos o kilos), partiendo de una cantidad ya sabida en kg.
function _configurarUnidadModalCantidad(cantidadKg) {
  const input = document.getElementById("mcr-cantidad");
  const sufijo = document.getElementById("mcr-sufijo-unidad");
  const btnGramos = document.getElementById("mcr-btn-gramos");
  const btnKilos = document.getElementById("mcr-btn-kilos");
  const presets = document.getElementById("mcr-presets");

  btnGramos.classList.toggle("activo", _unidadModalCantidad === "g");
  btnKilos.classList.toggle("activo", _unidadModalCantidad === "kg");
  presets.innerHTML = "";

  if (_unidadModalCantidad === "g") {
    sufijo.textContent = "g";
    input.step = "1";
    input.min = "1";
    input.value = Math.round(cantidadKg * 1000);
    [100, 150, 200, 250].forEach((gramos) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn-secondary";
      b.textContent = `${gramos} g`;
      b.addEventListener("click", () => {
        input.value = gramos;
        actualizarSubtotalModalCantidad();
      });
      presets.appendChild(b);
    });
  } else {
    sufijo.textContent = "kg";
    input.step = "0.1";
    input.min = "0.1";
    // Redondeado a 1 decimal para que se vea "1" o "1.5" y no "1.003".
    input.value = Math.round(cantidadKg * 10) / 10;
    [0.5, 1, 1.5, 2].forEach((kilos) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn-secondary";
      b.textContent = `${kilos} kg`;
      b.addEventListener("click", () => {
        input.value = kilos;
        actualizarSubtotalModalCantidad();
      });
      presets.appendChild(b);
    });
  }
}

document.getElementById("mcr-btn-gramos").addEventListener("click", () => {
  if (_unidadModalCantidad === "g") return;
  const cantidadKg = _cantidadEnKgDesdeInput();
  _unidadModalCantidad = "g";
  _configurarUnidadModalCantidad(cantidadKg);
  actualizarSubtotalModalCantidad();
});
document.getElementById("mcr-btn-kilos").addEventListener("click", () => {
  if (_unidadModalCantidad === "kg") return;
  const cantidadKg = _cantidadEnKgDesdeInput();
  _unidadModalCantidad = "kg";
  _configurarUnidadModalCantidad(cantidadKg);
  actualizarSubtotalModalCantidad();
});

function actualizarSubtotalModalCantidad() {
  const cantidadKg = _unidadModalCantidad === "pieza"
    ? (parseFloat(document.getElementById("mcr-cantidad").value) || 0)
    : _cantidadEnKgDesdeInput();
  const subtotal = cantidadKg * _productoModalCantidad.precio_venta;
  document.getElementById("mcr-subtotal").textContent = subtotal.toFixed(2);
}
document.getElementById("mcr-cantidad").addEventListener("input", actualizarSubtotalModalCantidad);

function _pasoModalCantidad() {
  if (_unidadModalCantidad === "g") return 10;
  if (_unidadModalCantidad === "kg") return 0.5;
  return 1;
}
document.getElementById("mcr-menos").addEventListener("click", () => {
  const input = document.getElementById("mcr-cantidad");
  const paso = _pasoModalCantidad();
  const nuevo = Math.max(paso, (parseFloat(input.value) || 0) - paso);
  input.value = _unidadModalCantidad === "kg" ? Math.round(nuevo * 10) / 10 : nuevo;
  actualizarSubtotalModalCantidad();
});
document.getElementById("mcr-mas").addEventListener("click", () => {
  const input = document.getElementById("mcr-cantidad");
  const paso = _pasoModalCantidad();
  const nuevo = (parseFloat(input.value) || 0) + paso;
  input.value = _unidadModalCantidad === "kg" ? Math.round(nuevo * 10) / 10 : nuevo;
  actualizarSubtotalModalCantidad();
});
document.getElementById("mcr-cancelar").addEventListener("click", () => {
  document.getElementById("modal-cantidad-rapida").style.display = "none";
});
document.getElementById("mcr-agregar").addEventListener("click", () => {
  const cantidad = _unidadModalCantidad === "pieza"
    ? parseFloat(document.getElementById("mcr-cantidad").value)
    : _cantidadEnKgDesdeInput();
  if (!cantidad || cantidad <= 0) {
    toast("Ingresa una cantidad válida", true);
    return;
  }
  if (_productoModalCantidad.stock != null && cantidad > _productoModalCantidad.stock) {
    toast(
      `No hay suficiente stock de "${_productoModalCantidad.nombre}" (disponible: ${formatearCantidad(_productoModalCantidad.stock, _productoModalCantidad.unidad_venta)})`,
      true
    );
    return;
  }

  if (_idxEdicionCarrito !== null) {
    carrito[_idxEdicionCarrito].cantidad = cantidad;
  } else {
    carrito.push({
      codigo_barras: _productoModalCantidad.codigo_barras,
      nombre: _productoModalCantidad.nombre,
      precio: _productoModalCantidad.precio_venta,
      cantidad,
      stock: _productoModalCantidad.stock,
      unidad_venta: _productoModalCantidad.unidad_venta || "pieza",
    });
  }
  renderCarrito();
  sonidoBeepEscaneo();
  toast(`${_productoModalCantidad.nombre} agregado`);
  document.getElementById("modal-cantidad-rapida").style.display = "none";
});

document.getElementById("btn-cobrar").addEventListener("click", () => {
  if (carrito.length === 0) {
    toast("El carrito está vacío", true);
    return;
  }
  abrirModalConfirmarVenta();
});

function abrirModalConfirmarVenta() {
  const total = carrito.reduce((acc, i) => acc + i.precio * i.cantidad, 0);
  const numArticulos = carrito.reduce((acc, i) => acc + i.cantidad, 0);
  const metodo = document.getElementById("metodo-pago").selectedOptions[0].textContent;
  const esEfectivo = document.getElementById("metodo-pago").value === "efectivo";

  document.getElementById("modal-venta-resumen").textContent =
    `${numArticulos} artículo(s) · Pago: ${metodo}`;
  document.getElementById("modal-venta-total").textContent = total.toFixed(2);

  document.getElementById("cobro-rapido").style.display = esEfectivo ? "block" : "none";
  if (esEfectivo) _prepararCobroRapido(total);

  document.getElementById("modal-confirmar-venta").style.display = "flex";
}

// ---- Cobro rápido: sugiere con qué billete es más probable que pague el
// cliente (según los billetes que circulan en México: 20, 50, 100, 200 y
// 500; el de 1000 casi no se usa en una tienda y solo se ofrece si no
// alcanza con los demás) y calcula el cambio al instante. ----
const DENOMINACIONES_MXN = [20, 50, 100, 200, 500];

function _calcularOpcionesCobro(total) {
  let opciones = DENOMINACIONES_MXN.filter((billete) => billete >= total);
  if (opciones.length === 0) {
    // El total supera el billete más alto de uso común (500): en vez de
    // ofrecer un solo billete que no alcanzaría a cubrir la compra, se
    // sugieren montos redondeados hacia arriba que sí la cubren (varios
    // billetes grandes juntos, como haría el cliente en la práctica).
    const candidatos = new Set([
      Math.ceil(total / 500) * 500,
      Math.ceil(total / 1000) * 1000,
      Math.ceil(total / 500) * 500 + 500,
    ]);
    opciones = [...candidatos].filter((v) => v >= total).sort((a, b) => a - b);
  }
  return opciones.slice(0, 3);
}

function _prepararCobroRapido(total) {
  const contenedor = document.getElementById("billetes-sugeridos");
  const inputRecibido = document.getElementById("input-recibido");
  contenedor.innerHTML = "";
  inputRecibido.value = "";
  _mostrarResultadoCobro(total, null);

  const opciones = _calcularOpcionesCobro(total);
  // Si el total no coincide con ninguno de los billetes sugeridos (lo más
  // común, ya que casi ningún total cae justo en $100, $200, etc.), se
  // agrega primero un chip de "Pago exacto" con el monto tal cual, para el
  // cliente que paga con el cambio justo o por transferencia/tarjeta puesta
  // como efectivo exacto.
  const yaHayExacto = opciones.some((billete) => Math.abs(billete - total) < 0.005);
  if (!yaHayExacto) {
    const chipExacto = _crearChipCobro(total, total, "Pago exacto");
    contenedor.appendChild(chipExacto);
  }

  opciones.forEach((billete) => {
    const cambio = billete - total;
    const chip = _crearChipCobro(billete, total, cambio > 0 ? `Cambio $${cambio.toFixed(2)}` : "Pago exacto");
    contenedor.appendChild(chip);
  });
}

function _crearChipCobro(monto, total, textoSecundario) {
  const inputRecibido = document.getElementById("input-recibido");
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip-billete";
  chip.innerHTML = `<span class="chip-billete-monto">$${monto % 1 === 0 ? monto : monto.toFixed(2)}</span><span class="chip-billete-cambio">${textoSecundario}</span>`;
  chip.addEventListener("click", () => {
    inputRecibido.value = monto;
    document.querySelectorAll(".chip-billete").forEach((c) => c.classList.remove("activo"));
    chip.classList.add("activo");
    _mostrarResultadoCobro(total, monto);
  });
  return chip;
}

function _mostrarResultadoCobro(total, recibido) {
  const resultado = document.getElementById("cobro-resultado");
  if (recibido === null || recibido === undefined || isNaN(recibido)) {
    resultado.textContent = "";
    resultado.className = "cobro-resultado";
    return;
  }
  const diferencia = recibido - total;
  if (diferencia < 0) {
    resultado.textContent = `Faltan $${Math.abs(diferencia).toFixed(2)}`;
    resultado.className = "cobro-resultado cambio-falta";
  } else if (diferencia === 0) {
    resultado.textContent = "Pago exacto, sin cambio";
    resultado.className = "cobro-resultado cambio-ok";
  } else {
    resultado.textContent = `Cambio a entregar: $${diferencia.toFixed(2)}`;
    resultado.className = "cobro-resultado cambio-ok";
  }
}

document.getElementById("input-recibido").addEventListener("input", (e) => {
  document.querySelectorAll(".chip-billete").forEach((c) => c.classList.remove("activo"));
  const total = parseFloat(document.getElementById("modal-venta-total").textContent) || 0;
  const recibido = parseFloat(e.target.value);
  _mostrarResultadoCobro(total, e.target.value.trim() === "" ? null : recibido);
});

function cerrarModalConfirmarVenta() {
  document.getElementById("modal-confirmar-venta").style.display = "none";
}

document.getElementById("btn-cancelar-venta-modal").addEventListener("click", cerrarModalConfirmarVenta);

document.getElementById("btn-confirmar-venta-modal").addEventListener("click", async () => {
  const btnConfirmar = document.getElementById("btn-confirmar-venta-modal");
  btnConfirmar.disabled = true;
  try {
    const venta = await api("/ventas", {
      method: "POST",
      body: JSON.stringify({
        items: carrito.map((i) => ({ codigo_barras: i.codigo_barras, cantidad: i.cantidad })),
        metodo_pago: document.getElementById("metodo-pago").value,
      }),
    });

    // Si fue en efectivo y el cajero capturó con cuánto pagó el cliente,
    // se muestra el cambio a entregar junto con la confirmación de la venta.
    const esEfectivo = document.getElementById("metodo-pago").value === "efectivo";
    const recibido = parseFloat(document.getElementById("input-recibido").value);
    let mensaje = `Venta #${venta.id} registrada — Total $${venta.total.toFixed(2)}`;
    if (esEfectivo && !isNaN(recibido) && recibido >= venta.total) {
      mensaje += ` — Cambio: $${(recibido - venta.total).toFixed(2)}`;
    }
    toast(mensaje);

    carrito = [];
    renderCarrito();
    cerrarModalConfirmarVenta();
  } catch (e) {
    toast(e.message, true);
    cerrarModalConfirmarVenta();
  } finally {
    btnConfirmar.disabled = false;
  }
});

// ---------------------------------------------------------
// PRODUCTOS (alta, edición, baja)
// ---------------------------------------------------------

// Ajusta el formulario según si el producto se vende por pieza o a granel
// (por kg), y si tiene o no código de barras real.
function actualizarUIFormularioProducto() {
  const esGranel = document.getElementById("prod-unidad-venta").value === "kg";
  const tieneCodigo = document.getElementById("prod-tiene-codigo").checked;

  document.getElementById("prod-precio").placeholder = esGranel ? "Precio por kilogramo *" : "Precio de venta *";
  document.getElementById("prod-stock").placeholder = esGranel ? "Stock inicial (kg)" : "Stock inicial";
  document.getElementById("prod-stock-min").placeholder = esGranel ? "Stock mínimo (kg)" : "Stock mínimo";
  document.getElementById("prod-stock").step = esGranel ? "0.001" : "1";
  document.getElementById("prod-stock-min").step = esGranel ? "0.001" : "1";

  const campoCodigo = document.getElementById("prod-codigo");
  const btnScan = document.getElementById("btn-scan-alta");
  campoCodigo.style.display = tieneCodigo ? "block" : "none";
  btnScan.style.display = tieneCodigo ? "inline-flex" : "none";
  campoCodigo.required = tieneCodigo;
  document.getElementById("aviso-codigo-interno").style.display = tieneCodigo ? "none" : "block";
}
document.getElementById("prod-unidad-venta").addEventListener("change", actualizarUIFormularioProducto);
document.getElementById("prod-tiene-codigo").addEventListener("change", actualizarUIFormularioProducto);
actualizarUIFormularioProducto();

document.getElementById("form-producto").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("prod-id").value;
  const tieneCodigo = document.getElementById("prod-tiene-codigo").checked;
  const payload = {
    codigo_barras: tieneCodigo ? document.getElementById("prod-codigo").value : null,
    nombre: document.getElementById("prod-nombre").value,
    descripcion: document.getElementById("prod-descripcion").value,
    categoria: document.getElementById("prod-categoria").value || "General",
    precio_venta: parseFloat(document.getElementById("prod-precio").value),
    costo: parseFloat(document.getElementById("prod-costo").value || 0),
    stock: parseFloat(document.getElementById("prod-stock").value || 0),
    stock_minimo: parseFloat(document.getElementById("prod-stock-min").value || 0),
    unidad_venta: document.getElementById("prod-unidad-venta").value,
    requiere_codigo: tieneCodigo,
    proveedor_id: document.getElementById("prod-proveedor").value
      ? parseInt(document.getElementById("prod-proveedor").value, 10)
      : null,
  };

  try {
    if (id) {
      await api(`/productos/${id}`, { method: "PUT", body: JSON.stringify(payload) });
      toast("Producto actualizado");
    } else {
      await api("/productos", { method: "POST", body: JSON.stringify(payload) });
      toast("Producto dado de alta");
    }
    resetFormProducto();
    cargarProductos();
    cargarVentaRapida();
  } catch (e) {
    toast(e.message, true);
  }
});

document.getElementById("btn-cancelar-edicion").addEventListener("click", () => {
  resetFormProducto();
});

// --- Exportar / importar catálogo de productos en Excel ---
document.getElementById("btn-exportar-productos").addEventListener("click", () => {
  descargarArchivo("/productos/exportar/excel", "productos.xlsx");
});

document.getElementById("btn-plantilla-productos").addEventListener("click", () => {
  descargarArchivo("/productos/plantilla-excel", "plantilla_productos.xlsx");
});

document.getElementById("btn-importar-productos").addEventListener("click", () => {
  document.getElementById("input-importar-productos").click();
});

document.getElementById("input-importar-productos").addEventListener("change", async (e) => {
  const archivo = e.target.files[0];
  if (!archivo) return;
  try {
    const resultado = await subirArchivo("/productos/importar/excel", "archivo", archivo);
    let mensaje = `Importación completa: ${resultado.creados} creados, ${resultado.actualizados} actualizados`;
    if (resultado.errores.length) {
      mensaje += `, ${resultado.errores.length} fila(s) con errores`;
      console.warn("Errores al importar productos:", resultado.errores);
    }
    toast(mensaje, resultado.errores.length > 0);
    cargarProductos();
    cargarVentaRapida();
  } catch (err) {
    toast(err.message, true);
  } finally {
    e.target.value = ""; // permite volver a subir el mismo archivo si hace falta
  }
});

function resetFormProducto() {
  document.getElementById("form-producto").reset();
  document.getElementById("prod-id").value = "";
  document.getElementById("prod-codigo").disabled = false;
  document.getElementById("prod-unidad-venta").value = "pieza";
  document.getElementById("prod-tiene-codigo").checked = true;
  document.getElementById("prod-proveedor").value = "";
  document.getElementById("prod-stock-max").style.display = "none";
  document.getElementById("prod-stock").disabled = false;
  const titulo = document.getElementById("titulo-form-producto");
  if (titulo) titulo.textContent = "Alta de producto";
  const btnCancelar = document.getElementById("btn-cancelar-edicion");
  if (btnCancelar) btnCancelar.style.display = "none";
  const btnGuardar = document.getElementById("btn-guardar-producto");
  if (btnGuardar) btnGuardar.textContent = "Guardar producto";
  actualizarUIFormularioProducto();
}

function editarProducto(p) {
  // Lleva al formulario de alta (ya no hay modal) y lo rellena para editar.
  const tabBtn = document.querySelector('.tab-btn[data-tab="productos"]');
  if (tabBtn) tabBtn.click();
  document.getElementById("prod-id").value = p.id;
  document.getElementById("prod-unidad-venta").value = p.unidad_venta || "pieza";
  document.getElementById("prod-tiene-codigo").checked = p.requiere_codigo !== false;
  actualizarUIFormularioProducto();
  document.getElementById("prod-codigo").value = p.requiere_codigo === false ? "" : p.codigo_barras;
  document.getElementById("prod-codigo").disabled = true; // el código no se edita
  document.getElementById("prod-nombre").value = p.nombre;
  document.getElementById("prod-descripcion").value = p.descripcion || "";
  document.getElementById("prod-categoria").value = p.categoria || "";
  document.getElementById("prod-precio").value = p.precio_venta;
  document.getElementById("prod-costo").value = p.costo;
  document.getElementById("prod-stock").value = p.stock;
  document.getElementById("prod-stock").disabled = true; // el stock se ajusta en Inventario
  document.getElementById("prod-stock-min").value = p.stock_minimo;
  document.getElementById("prod-stock-max").value =
    `${formatearCantidad(p.stock_maximo, p.unidad_venta)} (sube solo con cada entrada de mercancía)`;
  document.getElementById("prod-stock-max").style.display = "";
  document.getElementById("prod-proveedor").value = p.proveedor_id || "";
  const titulo = document.getElementById("titulo-form-producto");
  if (titulo) titulo.textContent = "Editar producto";
  const btnCancelar = document.getElementById("btn-cancelar-edicion");
  if (btnCancelar) btnCancelar.style.display = "";
  const btnGuardar = document.getElementById("btn-guardar-producto");
  if (btnGuardar) btnGuardar.textContent = "Guardar cambios";
}

async function darDeBaja(id, nombre) {
  const ok = await confirmarAccion({
    titulo: "Dar de baja producto",
    mensaje: `¿Dar de baja "${nombre}"? Podrás reactivarlo después.`,
    textoAceptar: "Sí, dar de baja",
    textoCancelar: "Cancelar",
    peligro: true,
  });
  if (!ok) return;
  try {
    await api(`/productos/${id}`, { method: "DELETE" });
    toast("Producto dado de baja");
    cargarProductos();
  } catch (e) {
    toast(e.message, true);
  }
}

async function reactivar(id) {
  try {
    await api(`/productos/${id}/reactivar`, { method: "POST" });
    toast("Producto reactivado");
    cargarProductos();
  } catch (e) {
    toast(e.message, true);
  }
}

let _datosProductos = [];

async function cargarProductos() {
  const verInactivos = document.getElementById("ver-inactivos").checked;
  const buscar = document.getElementById("buscar-producto").value;
  const proveedorId = document.getElementById("filtro-proveedor-producto").value;
  let query = "";
  if (!verInactivos) query += "&activos=true";
  if (buscar) query += `&buscar=${encodeURIComponent(buscar)}`;
  if (proveedorId) query += `&proveedor_id=${proveedorId}`;
  _datosProductos = await api(`/productos?${query}`);
  _renderProductos();
}

function _renderProductos() {
  const tbody = document.querySelector("#tabla-productos tbody");
  tbody.innerHTML = "";
  _recortarPorLimite(_datosProductos, "limite-productos").forEach((p) => {
    const tr = document.createElement("tr");
    const esGranel = p.unidad_venta === "kg";
    tr.innerHTML = `
      <td>${p.requiere_codigo === false ? "— (interno)" : p.codigo_barras}</td>
      <td>${p.nombre}${esGranel ? '<span class="badge badge-granel">Granel</span>' : ""}</td>
      <td>${p.proveedor_nombre || "—"}</td>
      <td>$${p.precio_venta.toFixed(2)}${esGranel ? "/kg" : ""}</td>
      <td>${formatearCantidad(p.stock, p.unidad_venta)}</td>
      <td><span class="badge ${p.activo ? "badge-activo" : "badge-inactivo"}">${p.activo ? "Activo" : "Baja"}</span></td>
      <td>
        ${tienePermiso("productos.editar")
          ? `<button class="link-btn" onclick='editarProducto(${JSON.stringify(p)})'>Editar</button>`
          : ""}
        ${tienePermiso("productos.baja")
          ? (p.activo
            ? `<button class="link-btn danger" onclick="darDeBaja(${p.id}, '${p.nombre.replace(/'/g, "")}')">Baja</button>`
            : `<button class="link-btn" onclick="reactivar(${p.id})">Reactivar</button>`)
          : ""}
      </td>
    `;
    tbody.appendChild(tr);
  });
}
document.getElementById("buscar-producto").addEventListener("input", cargarProductos);
document.getElementById("ver-inactivos").addEventListener("change", cargarProductos);
document.getElementById("filtro-proveedor-producto").addEventListener("change", cargarProductos);
document.getElementById("limite-productos").addEventListener("change", _renderProductos);

// ---------------------------------------------------------
// PROVEEDORES (alta, edición, baja, y sugerencia de pedido)
// ---------------------------------------------------------

const NOMBRES_DIAS = ["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"];

/** Llena los selects de proveedor del formulario de productos y del filtro del catálogo. */
async function cargarProveedoresSelects() {
  const proveedores = await api("/proveedores?activos=true");

  const selectProducto = document.getElementById("prod-proveedor");
  const seleccionActual = selectProducto.value;
  selectProducto.innerHTML = '<option value="">Sin proveedor asignado</option>';
  proveedores.forEach((p) => {
    selectProducto.innerHTML += `<option value="${p.id}">${p.nombre}</option>`;
  });
  selectProducto.value = seleccionActual;

  const selectFiltro = document.getElementById("filtro-proveedor-producto");
  const filtroActual = selectFiltro.value;
  selectFiltro.innerHTML = '<option value="">Todos los proveedores</option>';
  proveedores.forEach((p) => {
    selectFiltro.innerHTML += `<option value="${p.id}">${p.nombre}</option>`;
  });
  selectFiltro.value = filtroActual;
}

document.getElementById("form-proveedor").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("prov-id").value;
  const diaVisita = document.getElementById("prov-dia-visita").value;
  const payload = {
    nombre: document.getElementById("prov-nombre").value,
    contacto: document.getElementById("prov-contacto").value,
    telefono: document.getElementById("prov-telefono").value,
    dia_visita: diaVisita === "" ? null : parseInt(diaVisita, 10),
    frecuencia_dias: parseInt(document.getElementById("prov-frecuencia").value, 10),
    notas: document.getElementById("prov-notas").value,
  };

  try {
    if (id) {
      await api(`/proveedores/${id}`, { method: "PUT", body: JSON.stringify(payload) });
      toast("Proveedor actualizado");
    } else {
      await api("/proveedores", { method: "POST", body: JSON.stringify(payload) });
      toast("Proveedor dado de alta");
    }
    resetFormProveedor();
    cargarProveedores();
    cargarProveedoresSelects();
  } catch (err) {
    toast(err.message, true);
  }
});

document.getElementById("btn-cancelar-edicion-proveedor").addEventListener("click", () => {
  resetFormProveedor();
});

function resetFormProveedor() {
  document.getElementById("form-proveedor").reset();
  document.getElementById("prov-id").value = "";
  const titulo = document.getElementById("titulo-form-proveedor");
  if (titulo) titulo.textContent = "Alta de proveedor";
  const btnCancelar = document.getElementById("btn-cancelar-edicion-proveedor");
  if (btnCancelar) btnCancelar.style.display = "none";
  const btnGuardar = document.getElementById("btn-guardar-proveedor");
  if (btnGuardar) btnGuardar.textContent = "Guardar proveedor";
}

function editarProveedor(p) {
  // Lleva al formulario de alta (ya no hay modal) y lo rellena para editar.
  const tabBtn = document.querySelector('.tab-btn[data-tab="proveedores"]');
  if (tabBtn) tabBtn.click();
  document.getElementById("prov-id").value = p.id;
  document.getElementById("prov-nombre").value = p.nombre;
  document.getElementById("prov-contacto").value = p.contacto || "";
  document.getElementById("prov-telefono").value = p.telefono || "";
  document.getElementById("prov-dia-visita").value = p.dia_visita === null || p.dia_visita === undefined ? "" : p.dia_visita;
  document.getElementById("prov-frecuencia").value = p.frecuencia_dias;
  document.getElementById("prov-notas").value = p.notas || "";
  const titulo = document.getElementById("titulo-form-proveedor");
  if (titulo) titulo.textContent = "Editar proveedor";
  const btnCancelar = document.getElementById("btn-cancelar-edicion-proveedor");
  if (btnCancelar) btnCancelar.style.display = "";
  const btnGuardar = document.getElementById("btn-guardar-proveedor");
  if (btnGuardar) btnGuardar.textContent = "Guardar cambios";
}

async function darDeBajaProveedor(id, nombre) {
  const ok = await confirmarAccion({
    titulo: "Dar de baja proveedor",
    mensaje: `¿Dar de baja al proveedor "${nombre}"? Sus productos no se ven afectados.`,
    textoAceptar: "Sí, dar de baja",
    textoCancelar: "Cancelar",
    peligro: true,
  });
  if (!ok) return;
  try {
    await api(`/proveedores/${id}`, { method: "DELETE" });
    toast("Proveedor dado de baja");
    cargarProveedores();
    cargarProveedoresSelects();
  } catch (e) {
    toast(e.message, true);
  }
}

async function reactivarProveedor(id) {
  try {
    await api(`/proveedores/${id}/reactivar`, { method: "POST" });
    toast("Proveedor reactivado");
    cargarProveedores();
    cargarProveedoresSelects();
  } catch (e) {
    toast(e.message, true);
  }
}

let _datosProveedores = [];

async function cargarProveedores() {
  const verInactivos = document.getElementById("ver-inactivos-proveedores").checked;
  _datosProveedores = await api(`/proveedores${verInactivos ? "" : "?activos=true"}`);
  _renderProveedores();
}

function _renderProveedores() {
  const tbody = document.querySelector("#tabla-proveedores tbody");
  tbody.innerHTML = "";
  _recortarPorLimite(_datosProveedores, "limite-proveedores").forEach((p) => {
    const tr = document.createElement("tr");
    const visita = p.dia_visita === null ? "Sin día fijo" : NOMBRES_DIAS[p.dia_visita];
    const frecuencia = p.frecuencia_dias === 7 ? "semanal" : `cada ${p.frecuencia_dias} días`;
    tr.innerHTML = `
      <td>${p.nombre}</td>
      <td>${p.contacto || "—"}${p.telefono ? " · " + p.telefono : ""}</td>
      <td>${visita} (${frecuencia})</td>
      <td><span class="badge ${p.activo ? "badge-activo" : "badge-inactivo"}">${p.activo ? "Activo" : "Baja"}</span></td>
      <td>
        ${tienePermiso("proveedores.editar")
          ? `<button class="link-btn" onclick='editarProveedor(${JSON.stringify(p)})'>Editar</button>`
          : ""}
        ${p.activo
          ? `${tienePermiso("proveedores.sugerencia")
              ? `<button class="link-btn" onclick="verSugerenciaPedido(${p.id}, '${p.nombre.replace(/'/g, "")}')">Sugerir pedido</button>`
              : ""}
             ${tienePermiso("proveedores.baja")
              ? `<button class="link-btn danger" onclick="darDeBajaProveedor(${p.id}, '${p.nombre.replace(/'/g, "")}')">Baja</button>`
              : ""}`
          : (tienePermiso("proveedores.baja")
            ? `<button class="link-btn" onclick="reactivarProveedor(${p.id})">Reactivar</button>`
            : "")}
      </td>
    `;
    tbody.appendChild(tr);
  });
}
document.getElementById("ver-inactivos-proveedores").addEventListener("change", cargarProveedores);
document.getElementById("limite-proveedores").addEventListener("change", _renderProveedores);

let proveedorSugerenciaActual = null;

async function verSugerenciaPedido(proveedorId, nombreProveedor) {
  try {
    const datos = await api(`/proveedores/${proveedorId}/sugerencia-pedido`);
    proveedorSugerenciaActual = { id: proveedorId, nombre: nombreProveedor };

    // Si el modal se reabre con datos nuevos, cualquier "deshacer" pendiente
    // de la vista anterior ya no aplica.
    _timeoutsQuitar.forEach(({ timeoutId, intervalId }) => {
      clearTimeout(timeoutId);
      clearInterval(intervalId);
    });
    _timeoutsQuitar.clear();

    document.getElementById("sugerencia-titulo").textContent = `Sugerencia de pedido — ${nombreProveedor}`;
    document.getElementById("sugerencia-info").textContent =
      `Sugerido = Stock máximo − Stock actual. Ajusta la cantidad a pedir si quieres comprar más o menos; el gasto se recalcula solo.`;

    const tbody = document.querySelector("#tabla-sugerencia-pedido tbody");
    tbody.innerHTML = "";
    datos.items.forEach((it) => {
      const alerta = it.stock <= it.stock_minimo;
      const paso = it.unidad_venta === "pieza" ? "1" : "0.001";
      const tr = document.createElement("tr");
      tr.dataset.productoId = it.producto_id;
      tr.innerHTML = `
        <td>${it.nombre}</td>
        <td>${it.stock}${alerta ? ' <span class="badge badge-granel">Bajo</span>' : ""}</td>
        <td>${it.stock_minimo}</td>
        <td>${it.stock_maximo}</td>
        <td>${it.sugerido}</td>
        <td>
          <input type="number" class="input-cantidad-pedido" min="0" step="${paso}"
            data-producto-id="${it.producto_id}" data-costo="${it.costo}" data-sugerido="${it.sugerido}"
            value="${it.sugerido}">
        </td>
        <td>$${it.costo.toFixed(2)}</td>
        <td class="celda-subtotal">$${(it.costo * it.sugerido).toFixed(2)}</td>
        <td>${it.motivo}</td>
        <td class="celda-acciones-pedido">
          <button type="button" class="btn-quitar-producto" data-nombre="${it.nombre.replace(/"/g, "&quot;")}" title="Quitar de esta lista de pedido">🗑️</button>
          <button type="button" class="btn-deshacer-quitar" style="display:none">
            <span class="deshacer-texto">↩️ Deshacer</span>
            <span class="deshacer-barra"><span class="deshacer-barra-relleno"></span></span>
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".input-cantidad-pedido").forEach((input) => {
      input.addEventListener("input", () => _actualizarFilaPedido(input));
    });
    tbody.querySelectorAll(".btn-quitar-producto").forEach((btn) => {
      btn.addEventListener("click", () => _quitarProductoDePedido(btn));
    });
    tbody.querySelectorAll(".btn-deshacer-quitar").forEach((btn) => {
      btn.addEventListener("click", () => _deshacerQuitarProducto(btn));
    });

    document.getElementById("tabla-sugerencia-pedido").style.display = datos.items.length ? "" : "none";
    document.getElementById("sugerencia-vacio").textContent =
      "No hay productos de este proveedor que necesiten pedido por ahora.";
    document.getElementById("sugerencia-vacio").style.display = datos.items.length ? "none" : "block";
    document.getElementById("sugerencia-resumen").style.display = datos.items.length ? "flex" : "none";
    _recalcularResumenPedido();
    document.getElementById("modal-sugerencia-pedido").style.display = "flex";
  } catch (e) {
    toast(e.message, true);
  }
}

/** Recalcula el subtotal de una fila cuando el usuario cambia la cantidad a pedir. */
function _actualizarFilaPedido(input) {
  const fila = input.closest("tr");
  const costo = parseFloat(input.dataset.costo) || 0;
  const sugerido = parseFloat(input.dataset.sugerido) || 0;
  let cantidad = parseFloat(input.value);
  if (isNaN(cantidad) || cantidad < 0) cantidad = 0;

  input.classList.toggle("cantidad-modificada", cantidad !== sugerido);
  fila.querySelector(".celda-subtotal").textContent = `$${(costo * cantidad).toFixed(2)}`;
  _recalcularResumenPedido();
}

/**
 * Suma el gasto total y el número de productos seleccionados (cantidad > 0).
 * Las filas marcadas como "pendiente de quitar" (dentro de su ventana de
 * deshacer) no cuentan, como si ya no estuvieran en la lista.
 */
function _recalcularResumenPedido() {
  let total = 0;
  let productos = 0;
  document.querySelectorAll("#tabla-sugerencia-pedido tbody tr").forEach((fila) => {
    if (fila.classList.contains("fila-pendiente-quitar")) return;
    const input = fila.querySelector(".input-cantidad-pedido");
    const cantidad = parseFloat(input.value) || 0;
    if (cantidad > 0) {
      total += cantidad * (parseFloat(input.dataset.costo) || 0);
      productos += 1;
    }
  });
  document.getElementById("resumen-pedido-total").textContent = total.toFixed(2);
  document.getElementById("resumen-pedido-productos").textContent = productos;
  document.getElementById("btn-hacer-pedido").disabled = productos === 0;
}

// Guarda, por producto_id, el temporizador que termina de quitar la fila
// tras la ventana de "deshacer".
const _timeoutsQuitar = new Map();
const TIEMPO_DESHACER_MS = 6000;

/**
 * Quita un producto de la lista de sugerencia actual (solo de esta vista,
 * no afecta al proveedor ni al producto). Útil cuando el proveedor
 * ofrece muchos productos pero el dueño solo quiere pedir algunos.
 * Pide confirmación antes de quitarlo, y deja unos segundos para
 * deshacerlo por si fue un error.
 */
async function _quitarProductoDePedido(btn) {
  const fila = btn.closest("tr");
  const nombre = btn.dataset.nombre;

  const ok = await confirmarAccion({
    titulo: "Quitar de la lista",
    mensaje: `¿Quitar "${nombre}" de esta lista de pedido? No se pedirá esta vez.`,
    textoAceptar: "Sí, quitar",
    textoCancelar: "Cancelar",
    peligro: true,
  });
  if (!ok) return;

  const productoId = fila.dataset.productoId;

  fila.classList.add("fila-pendiente-quitar");
  fila.querySelector(".input-cantidad-pedido").disabled = true;
  fila.querySelector(".btn-quitar-producto").style.display = "none";

  const btnDeshacer = fila.querySelector(".btn-deshacer-quitar");
  const textoDeshacer = btnDeshacer.querySelector(".deshacer-texto");
  const relleno = btnDeshacer.querySelector(".deshacer-barra-relleno");
  btnDeshacer.style.display = "";
  _recalcularResumenPedido();

  // Barra de progreso: arranca llena y se anima a 0 durante toda la
  // ventana de "deshacer", como referencia visual continua del tiempo
  // que queda. El texto además muestra el conteo en segundos redondos.
  relleno.style.transition = "none";
  relleno.style.transform = "scaleX(1)";
  void relleno.offsetWidth; // fuerza reflow para que la transición sí anime desde aquí
  relleno.style.transition = `transform ${TIEMPO_DESHACER_MS}ms linear`;
  relleno.style.transform = "scaleX(0)";

  let segundosRestantes = Math.round(TIEMPO_DESHACER_MS / 1000);
  textoDeshacer.textContent = `↩️ Deshacer (${segundosRestantes}s)`;
  const intervalId = setInterval(() => {
    segundosRestantes -= 1;
    if (segundosRestantes > 0) {
      textoDeshacer.textContent = `↩️ Deshacer (${segundosRestantes}s)`;
    }
  }, 1000);

  const timeoutId = setTimeout(() => {
    clearInterval(intervalId);
    _timeoutsQuitar.delete(productoId);
    _finalizarQuitarProducto(fila);
  }, TIEMPO_DESHACER_MS);
  _timeoutsQuitar.set(productoId, { timeoutId, intervalId });
}

/** Cancela la remoción pendiente y regresa la fila a su estado normal. */
function _deshacerQuitarProducto(btn) {
  const fila = btn.closest("tr");
  const productoId = fila.dataset.productoId;

  if (_timeoutsQuitar.has(productoId)) {
    const { timeoutId, intervalId } = _timeoutsQuitar.get(productoId);
    clearTimeout(timeoutId);
    clearInterval(intervalId);
    _timeoutsQuitar.delete(productoId);
  }

  fila.classList.remove("fila-pendiente-quitar");
  fila.querySelector(".input-cantidad-pedido").disabled = false;
  fila.querySelector(".btn-quitar-producto").style.display = "";
  const btnDeshacer = fila.querySelector(".btn-deshacer-quitar");
  btnDeshacer.style.display = "none";
  // Deja la barra lista (llena, sin transición) por si se vuelve a
  // quitar este mismo producto más adelante en esta misma sesión.
  const relleno = btnDeshacer.querySelector(".deshacer-barra-relleno");
  relleno.style.transition = "none";
  relleno.style.transform = "scaleX(1)";

  _recalcularResumenPedido();
  toast("Producto restaurado a la lista");
}

/** Termina de quitar la fila de la tabla una vez que ya pasó la ventana de deshacer. */
function _finalizarQuitarProducto(fila) {
  fila.classList.add("fila-quitandose");
  setTimeout(() => {
    fila.remove();
    _recalcularResumenPedido();

    const quedan = document.querySelectorAll("#tabla-sugerencia-pedido tbody tr").length;
    document.getElementById("tabla-sugerencia-pedido").style.display = quedan ? "" : "none";
    if (!quedan) {
      document.getElementById("sugerencia-vacio").textContent =
        "Quitaste todos los productos de esta lista. Cierra y vuelve a abrir la sugerencia si quieres empezar de nuevo.";
    }
    document.getElementById("sugerencia-vacio").style.display = quedan ? "none" : "block";
    document.getElementById("sugerencia-resumen").style.display = quedan ? "flex" : "none";
  }, 180);
}

function cerrarModalSugerencia() {
  document.getElementById("modal-sugerencia-pedido").style.display = "none";
  proveedorSugerenciaActual = null;
  _timeoutsQuitar.forEach(({ timeoutId, intervalId }) => {
    clearTimeout(timeoutId);
    clearInterval(intervalId);
  });
  _timeoutsQuitar.clear();
}
document.getElementById("btn-cerrar-sugerencia").addEventListener("click", cerrarModalSugerencia);
document.getElementById("modal-sugerencia-pedido").addEventListener("click", (e) => {
  if (e.target.id === "modal-sugerencia-pedido") cerrarModalSugerencia();
});

document.getElementById("btn-exportar-sugerencia").addEventListener("click", () => {
  if (!proveedorSugerenciaActual) return;
  descargarArchivo(
    `/proveedores/${proveedorSugerenciaActual.id}/sugerencia-pedido/excel`,
    `pedido_${proveedorSugerenciaActual.nombre.replace(/\s+/g, "_")}.xlsx`
  );
});

document.getElementById("btn-hacer-pedido").addEventListener("click", async () => {
  if (!proveedorSugerenciaActual) return;

  const items = [];
  document.querySelectorAll("#tabla-sugerencia-pedido tbody tr").forEach((fila) => {
    if (fila.classList.contains("fila-pendiente-quitar")) return;
    const input = fila.querySelector(".input-cantidad-pedido");
    const cantidad = parseFloat(input.value) || 0;
    if (cantidad > 0) {
      items.push({ producto_id: parseInt(input.dataset.productoId, 10), cantidad });
    }
  });
  if (!items.length) {
    toast("Indica al menos una cantidad mayor a 0 para hacer el pedido", true);
    return;
  }

  const total = document.getElementById("resumen-pedido-total").textContent;
  const ok = await confirmarAccion({
    titulo: "Confirmar pedido",
    mensaje: `¿Confirmar pedido a "${proveedorSugerenciaActual.nombre}" por ${items.length} producto(s)?\nGasto total estimado: $${total}\n\nEsto sumará el stock de inmediato y se contará en tus gastos.`,
    textoAceptar: "Sí, hacer pedido",
    textoCancelar: "Cancelar",
    peligro: false,
  });
  if (!ok) return;

  try {
    const resultado = await api(`/proveedores/${proveedorSugerenciaActual.id}/hacer-pedido`, {
      method: "POST",
      body: JSON.stringify({ items }),
    });
    toast(`Pedido registrado — ${resultado.total_productos} producto(s), gasto total $${resultado.total_gasto.toFixed(2)}`);
    // Refresca la sugerencia (con el stock ya actualizado) y las vistas que dependen del stock.
    await verSugerenciaPedido(proveedorSugerenciaActual.id, proveedorSugerenciaActual.nombre);
    cargarProductos();
  } catch (e) {
    toast(e.message, true);
  }
});

// ---------------------------------------------------------
// OTROS GASTOS (renta, luz, sueldos, etc.)
// ---------------------------------------------------------
document.getElementById("form-gasto").addEventListener("submit", async (e) => {
  e.preventDefault();
  const fecha = document.getElementById("gasto-fecha").value;
  const payload = {
    concepto: document.getElementById("gasto-concepto").value,
    categoria: document.getElementById("gasto-categoria").value,
    monto: parseFloat(document.getElementById("gasto-monto").value),
    fecha: fecha || null,
    notas: document.getElementById("gasto-notas").value,
  };
  try {
    await api("/otros-gastos", { method: "POST", body: JSON.stringify(payload) });
    toast("Gasto registrado");
    document.getElementById("form-gasto").reset();
    document.getElementById("gasto-categoria").value = "otro";
    cargarOtrosGastos();
  } catch (err) {
    toast(err.message || "No se pudo registrar el gasto", true);
  }
});

const _NOMBRES_CATEGORIA_GASTO = {
  renta: "Renta",
  luz: "Luz",
  agua: "Agua",
  internet: "Internet / teléfono",
  sueldo: "Sueldo / nómina",
  mantenimiento: "Mantenimiento",
  otro: "Otro",
};

function _queryFechasGastos() {
  const fi = document.getElementById("gasto-fecha-inicio").value;
  const ff = document.getElementById("gasto-fecha-fin").value;
  let query = "";
  if (fi) query += `&fecha_inicio=${fi}`;
  if (ff) query += `&fecha_fin=${ff}`;
  return query;
}

let _datosOtrosGastos = [];

async function cargarOtrosGastos() {
  const gastos = await api(`/otros-gastos?${_queryFechasGastos()}`);
  const total = gastos.reduce((suma, g) => suma + g.monto, 0);
  document.getElementById("gastos-total").textContent = "$" + total.toFixed(2);

  _datosOtrosGastos = gastos;
  _renderOtrosGastosTab();
}

function _renderOtrosGastosTab() {
  const tbody = document.querySelector("#tabla-otros-gastos tbody");
  tbody.innerHTML = "";
  _recortarPorLimite(_datosOtrosGastos, "limite-otros-gastos").forEach((g) => {
    const tr = document.createElement("tr");
    const fecha = new Date(g.fecha).toLocaleDateString();
    tr.innerHTML = `
      <td>${fecha}</td>
      <td>${g.concepto}</td>
      <td>${_NOMBRES_CATEGORIA_GASTO[g.categoria] || g.categoria}</td>
      <td>$${g.monto.toFixed(2)}</td>
      <td>${g.registrado_por || "—"}</td>
      <td>${g.notas || ""}</td>
      <td>${tienePermiso("gastos.eliminar")
        ? `<button class="link-btn danger" onclick="eliminarOtroGasto(${g.id})">Eliminar</button>`
        : ""}</td>
    `;
    tbody.appendChild(tr);
  });
}
document.getElementById("limite-otros-gastos").addEventListener("change", _renderOtrosGastosTab);

async function eliminarOtroGasto(id) {
  const ok = await confirmarAccion({
    titulo: "Eliminar gasto",
    mensaje: "¿Eliminar este gasto?",
    textoAceptar: "Sí, eliminar",
    textoCancelar: "Cancelar",
    peligro: true,
  });
  if (!ok) return;
  try {
    await api(`/otros-gastos/${id}`, { method: "DELETE" });
    toast("Gasto eliminado");
    cargarOtrosGastos();
  } catch (err) {
    toast(err.message || "No se pudo eliminar el gasto", true);
  }
}

document.getElementById("btn-filtrar-gastos").addEventListener("click", cargarOtrosGastos);

// ---------------------------------------------------------
// INVENTARIO
// ---------------------------------------------------------
// El costo pagado solo aplica cuando el movimiento es una entrada (compra);
// en salidas o ajustes no representa un gasto, así que se oculta.
function _actualizarVisibilidadCostoInventario() {
  const esEntrada = document.getElementById("inv-tipo").value === "entrada";
  const inputCosto = document.getElementById("inv-costo-unitario");
  inputCosto.style.display = esEntrada ? "" : "none";
  if (!esEntrada) inputCosto.value = "";
}
document.getElementById("inv-tipo").addEventListener("change", _actualizarVisibilidadCostoInventario);
_actualizarVisibilidadCostoInventario();

document.getElementById("form-inventario").addEventListener("submit", async (e) => {
  e.preventDefault();
  const costoTexto = document.getElementById("inv-costo-unitario").value;
  const payload = {
    codigo_barras: document.getElementById("inv-codigo").value,
    tipo: document.getElementById("inv-tipo").value,
    cantidad: parseFloat(document.getElementById("inv-cantidad").value),
    costo_unitario: costoTexto ? parseFloat(costoTexto) : null,
    motivo: document.getElementById("inv-motivo").value,
  };
  try {
    await api("/inventario/movimiento", { method: "POST", body: JSON.stringify(payload) });
    toast("Movimiento registrado");
    document.getElementById("form-inventario").reset();
    document.getElementById("inv-codigo").readOnly = false;
    _limpiarSeleccionSinCodigo();
    document.getElementById("inv-producto-info").style.display = "none";
    cargarBajoStock();
    cargarMovimientos();
  } catch (e) {
    toast(e.message, true);
  }
});

let _datosBajoStock = [];

async function cargarBajoStock() {
  _datosBajoStock = await api("/inventario/bajo-stock");
  _renderBajoStock();
}

function _renderBajoStock() {
  const tbody = document.querySelector("#tabla-bajo-stock tbody");
  tbody.innerHTML = "";
  if (_datosBajoStock.length === 0) {
    tbody.innerHTML = `<tr><td colspan="3">Sin alertas de stock 👍</td></tr>`;
    return;
  }
  _recortarPorLimite(_datosBajoStock, "limite-bajo-stock").forEach((p) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${p.nombre}</td><td>${formatearCantidad(p.stock, p.unidad_venta)}</td><td>${formatearCantidad(p.stock_minimo, p.unidad_venta)}</td>`;
    tbody.appendChild(tr);
  });
}
document.getElementById("limite-bajo-stock").addEventListener("change", _renderBajoStock);

let _datosMovimientos = [];
let _mapaProductosMovimientos = {};

async function cargarMovimientos() {
  const fi = document.getElementById("mov-fecha-inicio").value;
  const ff = document.getElementById("mov-fecha-fin").value;
  let query = "";
  if (fi) query += `&fecha_inicio=${fi}`;
  if (ff) query += `&fecha_fin=${ff}`;
  const movimientos = await api(`/inventario/movimientos?${query}`);
  const productos = await api("/productos?");
  _mapaProductosMovimientos = Object.fromEntries(productos.map((p) => [p.id, p]));
  _datosMovimientos = movimientos;
  _renderMovimientos();
}

function _renderMovimientos() {
  const tbody = document.querySelector("#tabla-movimientos tbody");
  tbody.innerHTML = "";
  if (_datosMovimientos.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6">No hay movimientos en este periodo</td></tr>`;
    return;
  }
  _recortarPorLimite(_datosMovimientos, "limite-movimientos").forEach((m) => {
    const tr = document.createElement("tr");
    const fecha = new Date(m.fecha).toLocaleString();
    const producto = _mapaProductosMovimientos[m.producto_id];
    tr.innerHTML = `
      <td>${fecha}</td>
      <td>${producto ? producto.nombre : m.producto_id}</td>
      <td>${m.tipo}</td>
      <td>${producto ? formatearCantidad(m.cantidad, producto.unidad_venta) : m.cantidad}</td>
      <td>${m.costo_unitario != null ? "$" + m.costo_unitario.toFixed(2) : "—"}</td>
      <td>${m.motivo || ""}</td>
    `;
    tbody.appendChild(tr);
  });
}
document.getElementById("limite-movimientos").addEventListener("change", _renderMovimientos);
document.getElementById("btn-filtrar-movimientos").addEventListener("click", cargarMovimientos);

// ---------------------------------------------------------
// REPORTES
// ---------------------------------------------------------
document.getElementById("btn-filtrar-reporte").addEventListener("click", cargarReportes);

function _queryFechas() {
  const fi = document.getElementById("rep-fecha-inicio").value;
  const ff = document.getElementById("rep-fecha-fin").value;
  const params = [];
  if (fi) params.push(`fecha_inicio=${encodeURIComponent(fi)}`);
  if (ff) params.push(`fecha_fin=${encodeURIComponent(ff)}`);
  return params.length ? params.join("&") : "";
}

function _urlConFechas(basePath) {
  const q = _queryFechas();
  return q ? `${basePath}?${q}` : basePath;
}

document.getElementById("btn-exportar-excel").addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  descargarArchivo(_urlConFechas("/reportes/exportar/excel"), "reporte_ventas.xlsx");
});
document.getElementById("btn-exportar-pdf").addEventListener("click", (e) => {
  e.preventDefault();
  e.stopPropagation();
  descargarArchivo(_urlConFechas("/reportes/exportar/pdf"), "reporte_ventas.pdf");
});

// Guarda los datos completos de cada tabla del reporte, para poder
// cambiar cuántos registros se muestran sin tener que volver a pedirlos
// al servidor cada vez que el usuario cambia el filtro de "Mostrar".
const _datosReportes = {
  topProductos: [],
  ventas: [],
  gastos: [],
  mermas: [],
  otrosGastos: [],
};

// Devuelve cuántos registros hay que mostrar según el <select> indicado.
// "todos" se traduce en Infinity para no recortar el arreglo.
function _limiteSeleccionado(idSelect) {
  const valor = document.getElementById(idSelect).value;
  return valor === "todos" ? Infinity : parseInt(valor, 10);
}

// Recorta un arreglo de datos según el límite elegido en el <select>.
function _recortarPorLimite(datos, idSelect) {
  const limite = _limiteSeleccionado(idSelect);
  return Number.isFinite(limite) ? datos.slice(0, limite) : datos;
}

function _renderTopProductos() {
  const tbodyTop = document.querySelector("#tabla-top-productos tbody");
  tbodyTop.innerHTML = "";
  _recortarPorLimite(_datosReportes.topProductos, "limite-top-productos").forEach((p) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${p.nombre}</td><td>${p.unidades_vendidas}</td><td>$${p.ingresos.toFixed(2)}</td>`;
    tbodyTop.appendChild(tr);
  });
}

function _renderVentas() {
  const tbodyVentas = document.querySelector("#tabla-ventas tbody");
  tbodyVentas.innerHTML = "";
  _recortarPorLimite(_datosReportes.ventas, "limite-ventas").forEach((v) => {
    const tr = document.createElement("tr");
    const fecha = new Date(v.fecha).toLocaleString();
    tr.innerHTML = `
      <td>${v.id}</td>
      <td>${fecha}</td>
      <td>$${v.total.toFixed(2)}</td>
      <td>${v.metodo_pago}</td>
      <td>${v.vendido_por || "—"}</td>
      <td>${v.cancelada ? "Cancelada" : "OK"}</td>
      <td>${!v.cancelada && tienePermiso("reportes.cancelar")
        ? `<button class="link-btn danger" onclick="cancelarVenta(${v.id})">Cancelar</button>`
        : ""}</td>
    `;
    tbodyVentas.appendChild(tr);
  });
}

function _renderGastos() {
  const tbodyGastos = document.querySelector("#tabla-gastos tbody");
  tbodyGastos.innerHTML = "";
  _recortarPorLimite(_datosReportes.gastos, "limite-gastos").forEach((g) => {
    const tr = document.createElement("tr");
    const fecha = new Date(g.fecha).toLocaleString();
    tr.innerHTML = `
      <td>${fecha}</td>
      <td>${g.producto}</td>
      <td>${g.cantidad}</td>
      <td>$${g.costo_unitario.toFixed(2)}</td>
      <td>$${g.subtotal.toFixed(2)}</td>
      <td>${g.motivo || ""}</td>
    `;
    tbodyGastos.appendChild(tr);
  });
}

function _renderMermas() {
  const tbodyMermas = document.querySelector("#tabla-mermas tbody");
  tbodyMermas.innerHTML = "";
  _recortarPorLimite(_datosReportes.mermas, "limite-mermas").forEach((m) => {
    const tr = document.createElement("tr");
    const fecha = new Date(m.fecha).toLocaleString();
    tr.innerHTML = `
      <td>${fecha}</td>
      <td>${m.producto}</td>
      <td>${m.cantidad}</td>
      <td>$${m.costo_unitario.toFixed(2)}</td>
      <td>$${m.subtotal.toFixed(2)}</td>
      <td>${m.motivo || ""}</td>
    `;
    tbodyMermas.appendChild(tr);
  });
}

function _renderOtrosGastosReporte() {
  const tbodyOtrosGastos = document.querySelector("#tabla-reportes-otros-gastos tbody");
  tbodyOtrosGastos.innerHTML = "";
  _recortarPorLimite(_datosReportes.otrosGastos, "limite-reportes-otros-gastos").forEach((g) => {
    const tr = document.createElement("tr");
    const fecha = new Date(g.fecha).toLocaleDateString();
    tr.innerHTML = `
      <td>${fecha}</td>
      <td>${g.concepto}</td>
      <td>${_NOMBRES_CATEGORIA_GASTO[g.categoria] || g.categoria}</td>
      <td>$${g.monto.toFixed(2)}</td>
      <td>${g.registrado_por || "—"}</td>
    `;
    tbodyOtrosGastos.appendChild(tr);
  });
}

// Conecta cada <select> de "Mostrar" con la función que vuelve a pintar
// su tabla correspondiente, usando los datos ya guardados en memoria
// (no hace falta volver a llamar a la API al cambiar el límite).
const _renderPorLimite = {
  "limite-top-productos": _renderTopProductos,
  "limite-ventas": _renderVentas,
  "limite-gastos": _renderGastos,
  "limite-mermas": _renderMermas,
  "limite-reportes-otros-gastos": _renderOtrosGastosReporte,
};
Object.entries(_renderPorLimite).forEach(([id, render]) => {
  document.getElementById(id).addEventListener("change", render);
});

async function cargarReportes() {
  const query = _queryFechas();

  const resumen = await api(`/reportes/resumen?${query}`);
  document.getElementById("rep-num-ventas").textContent = resumen.num_ventas;
  document.getElementById("rep-ingresos").textContent = "$" + resumen.total_ingresos.toFixed(2);
  document.getElementById("rep-ticket").textContent = "$" + resumen.ticket_promedio.toFixed(2);

  const top = await api(`/reportes/top-productos?${query}`);
  _datosReportes.topProductos = top;
  _renderTopProductos();

  const ventas = await api(`/ventas?${query}`);
  _datosReportes.ventas = ventas;
  _renderVentas();

  const gastos = await api(`/reportes/gastos?${query}`);
  document.getElementById("rep-gastos").textContent = "$" + gastos.total_gastado.toFixed(2);
  _datosReportes.gastos = gastos.detalle;
  _renderGastos();

  const mermas = await api(`/reportes/mermas?${query}`);
  document.getElementById("rep-mermas").textContent = "$" + mermas.total_perdido.toFixed(2);
  _datosReportes.mermas = mermas.detalle;
  _renderMermas();

  const otrosGastos = await api(`/otros-gastos?${query}`);
  const totalOtrosGastos = otrosGastos.reduce((suma, g) => suma + g.monto, 0);
  document.getElementById("rep-otros-gastos").textContent = "$" + totalOtrosGastos.toFixed(2);
  _datosReportes.otrosGastos = otrosGastos;
  _renderOtrosGastosReporte();

  // Utilidad neta = ingresos por ventas, menos lo gastado en comprar
  // mercancía, menos el valor de lo perdido en mermas, menos los demás
  // gastos del negocio (renta, luz, sueldos, etc.)
  const utilidad = resumen.total_ingresos - gastos.total_gastado - mermas.total_perdido - totalOtrosGastos;
  const tarjetaUtilidad = document.getElementById("rep-utilidad").closest(".card");
  document.getElementById("rep-utilidad").textContent = "$" + utilidad.toFixed(2);
  tarjetaUtilidad.classList.toggle("negativa", utilidad < 0);

  const margen = await api(`/reportes/margen-bruto?${query}`);
  document.getElementById("rep-costo-vendido").textContent = "$" + margen.total_costo_vendido.toFixed(2);
  const tarjetaMargen = document.getElementById("rep-margen-bruto").closest(".card");
  document.getElementById("rep-margen-bruto").textContent =
    "$" + margen.margen_bruto.toFixed(2) + ` (${margen.porcentaje_margen}%)`;
  tarjetaMargen.classList.toggle("negativa", margen.margen_bruto < 0);
}

async function cancelarVenta(id) {
  const ok = await confirmarAccion({
    titulo: "Cancelar venta",
    mensaje: "¿Cancelar esta venta? El stock se devolverá al inventario.",
    textoAceptar: "Sí, cancelar venta",
    textoCancelar: "No, mantenerla",
    peligro: true,
  });
  if (!ok) return;
  try {
    await api(`/ventas/${id}/cancelar`, { method: "POST" });
    toast("Venta cancelada");
    cargarReportes();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------------------------------------------------------
// VERIFICAR EN TIEMPO REAL SI EL USUARIO YA EXISTE
// ---------------------------------------------------------
// Reutiliza GET /usuarios (ya restringido a admins) para comparar contra
// la lista actual. Con debounce para no lanzar una petición por cada tecla.
let usernameCheckTimer = null;
let usernameDisponible = null; // null = aún no se sabe / no se ha revisado

function actualizarFeedbackUsername(estado, mensaje) {
  const input = document.getElementById('user-username');
  const feedback = document.getElementById('username-feedback');
  feedback.textContent = mensaje;
  feedback.className = estado ? `username-feedback-${estado}` : '';
  input.classList.remove('input-valido', 'input-invalido');
  if (estado === 'available') input.classList.add('input-valido');
  if (estado === 'taken') input.classList.add('input-invalido');
}

document.getElementById('user-username').addEventListener('input', function () {
  const valor = this.value.trim();
  clearTimeout(usernameCheckTimer);

  if (!valor) {
    usernameDisponible = null;
    actualizarFeedbackUsername(null, '');
    return;
  }

  actualizarFeedbackUsername('checking', 'Verificando disponibilidad…');

  usernameCheckTimer = setTimeout(async () => {
    try {
      const usuarios = await api('/usuarios');
      const yaExiste = usuarios.some(
        (u) => u.username.toLowerCase() === valor.toLowerCase()
      );
      usernameDisponible = !yaExiste;
      if (yaExiste) {
        actualizarFeedbackUsername('taken', '✗ Ese nombre de usuario ya existe');
      } else {
        actualizarFeedbackUsername('available', '✓ Nombre de usuario disponible');
      }
    } catch (e) {
      // Si falla la verificación (ej. sin conexión), no bloqueamos al
      // usuario: el backend igual valida al enviar el formulario.
      usernameDisponible = null;
      actualizarFeedbackUsername(null, '');
    }
  }, 400);
});

// ---------------------------------------------------------
// PERMISOS (solo admin) — acciones granulares del rol Cajero
// ---------------------------------------------------------
const ACCIONES_POR_MODULO = {
  productos: [
    { clave: "productos.ver", label: "Ver catálogo" },
    { clave: "productos.agregar", label: "Agregar productos" },
    { clave: "productos.editar", label: "Editar productos" },
    { clave: "productos.baja", label: "Dar de baja / reactivar" },
    { clave: "productos.importar", label: "Importar / exportar Excel" },
  ],
  inventario: [
    { clave: "inventario.ver", label: "Ver movimientos y alertas de stock" },
    { clave: "inventario.movimiento", label: "Registrar entradas / salidas / ajustes" },
  ],
  proveedores: [
    { clave: "proveedores.ver", label: "Ver lista de proveedores" },
    { clave: "proveedores.agregar", label: "Agregar proveedores" },
    { clave: "proveedores.editar", label: "Editar proveedores" },
    { clave: "proveedores.baja", label: "Dar de baja / reactivar" },
    { clave: "proveedores.sugerencia", label: "Sugerencia de pedido" },
  ],
  gastos: [
    { clave: "gastos.ver", label: "Ver gastos registrados" },
    { clave: "gastos.agregar", label: "Registrar gastos" },
    { clave: "gastos.eliminar", label: "Eliminar gastos" },
  ],
  reportes: [
    { clave: "reportes.ver", label: "Ver reportes y exportar" },
    { clave: "reportes.cancelar", label: "Cancelar ventas" },
  ],
  caja: [
    { clave: "caja.ver", label: "Ver historial de cortes de caja" },
    { clave: "caja.cortar", label: "Hacer corte de caja" },
  ],
};

const NOMBRES_MODULO_PERMISO = {
  productos: "Productos",
  inventario: "Inventario",
  proveedores: "Proveedores",
  gastos: "Gastos",
  reportes: "Reportes",
  caja: "Caja",
};

function _construirUIPermisos() {
  const cont = document.getElementById("permisos-modulos");
  if (!cont || cont.dataset.built === "1") return;
  cont.innerHTML = "";
  Object.entries(ACCIONES_POR_MODULO).forEach(([modulo, acciones]) => {
    const bloque = document.createElement("div");
    bloque.className = "permiso-modulo";
    bloque.dataset.modulo = modulo;

    const header = document.createElement("label");
    header.className = "permiso-modulo-header";
    header.innerHTML = `
      <input type="checkbox" class="permiso-modulo-master" data-modulo="${modulo}">
      <span class="permiso-titulo">${NOMBRES_MODULO_PERMISO[modulo] || modulo}</span>
    `;
    bloque.appendChild(header);

    const lista = document.createElement("div");
    lista.className = "permiso-acciones";
    acciones.forEach((a) => {
      const id = "permiso-" + a.clave.replace(".", "-");
      const row = document.createElement("label");
      row.className = "permiso-accion";
      row.innerHTML = `
        <input type="checkbox" id="${id}" data-clave="${a.clave}" data-modulo="${modulo}">
        <span>${a.label}</span>
      `;
      lista.appendChild(row);
    });
    bloque.appendChild(lista);
    cont.appendChild(bloque);
  });
  cont.dataset.built = "1";

  // Master checkbox: marca/desmarca todas las acciones del módulo.
  cont.querySelectorAll(".permiso-modulo-master").forEach((master) => {
    master.addEventListener("change", () => {
      const modulo = master.dataset.modulo;
      cont.querySelectorAll(`input[data-clave][data-modulo="${modulo}"]`).forEach((chk) => {
        chk.checked = master.checked;
      });
    });
  });
  // Si se desmarca una acción, el master deja de estar checked (indeterminate si hay mezcla).
  cont.querySelectorAll("input[data-clave]").forEach((chk) => {
    chk.addEventListener("change", () => _actualizarMasterPermiso(chk.dataset.modulo));
  });
}

function _actualizarMasterPermiso(modulo) {
  const cont = document.getElementById("permisos-modulos");
  const checks = Array.from(cont.querySelectorAll(`input[data-clave][data-modulo="${modulo}"]`));
  const master = cont.querySelector(`.permiso-modulo-master[data-modulo="${modulo}"]`);
  if (!master) return;
  const n = checks.filter((c) => c.checked).length;
  master.checked = n === checks.length && n > 0;
  master.indeterminate = n > 0 && n < checks.length;
}

async function cargarPermisos() {
  try {
    _construirUIPermisos();
    const permisos = await api("/permisos");
    Object.values(ACCIONES_POR_MODULO).flat().forEach((a) => {
      const id = "permiso-" + a.clave.replace(".", "-");
      const chk = document.getElementById(id);
      if (chk) chk.checked = !!permisos[a.clave];
    });
    Object.keys(ACCIONES_POR_MODULO).forEach(_actualizarMasterPermiso);
  } catch (e) {
    toast(e.message, true);
  }
}

document.getElementById("form-permisos").addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload = {};
  Object.values(ACCIONES_POR_MODULO).flat().forEach((a) => {
    const id = "permiso-" + a.clave.replace(".", "-");
    const chk = document.getElementById(id);
    if (chk) payload[a.clave] = chk.checked;
  });
  try {
    await api("/permisos", { method: "PUT", body: JSON.stringify(payload) });
    toast("Permisos guardados");
  } catch (e) {
    toast(e.message, true);
  }
});

// ---------------------------------------------------------
// USUARIOS (solo admin)
// ---------------------------------------------------------
document.getElementById("form-usuario").addEventListener("submit", async (e) => {
  e.preventDefault();

  if (usernameDisponible === false) {
    toast("Ese nombre de usuario ya existe. Elige otro.", true);
    return;
  }

  const password = document.getElementById("user-password").value;
  
  // Validar la contraseña antes de enviar
  const requirements = [
    password.length >= 8,
    /[A-Z]/.test(password),
    /[a-z]/.test(password),
    /[0-9]/.test(password),
    /[!@#$%^&*]/.test(password),
  ];
  
  const allMet = requirements.every(req => req === true);
  
  if (!allMet) {
    toast("La contraseña no cumple con todos los requisitos. Revisa la lista de validación.", true);
    return;
  }
  
  const payload = {
    username: document.getElementById("user-username").value,
    nombre_completo: document.getElementById("user-nombre").value,
    password: password,
    rol: document.getElementById("user-rol").value,
  };
  
  try {
    await api("/usuarios", { method: "POST", body: JSON.stringify(payload) });
    toast("Usuario creado");
    document.getElementById("form-usuario").reset();
    usernameDisponible = null;
    actualizarFeedbackUsername(null, '');
    // Resetear los indicadores visuales
    document.querySelectorAll('.password-requirement-met, .password-requirement-fail').forEach(el => {
      el.classList.remove('password-requirement-met', 'password-requirement-fail');
    });
    document.querySelectorAll('#password-requirements [id$="-icon"]').forEach(icon => {
      icon.textContent = '○';
    });
    document.querySelectorAll('#password-strength .strength-meter-segment').forEach(seg => {
      seg.classList.remove('is-filled-weak', 'is-filled-medium', 'is-filled-strong');
    });
    document.getElementById('strength-text').textContent = '—';
    document.getElementById('strength-text').className = 'strength-meter-value';
    cargarUsuarios();
  } catch (e) {
    toast(e.message, true);
  }
});

async function cargarUsuarios() {
  const usuarios = await api("/usuarios");
  const tbody = document.querySelector("#tabla-usuarios tbody");
  tbody.innerHTML = "";
  usuarios.forEach((u) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${u.username}</td>
      <td>${u.nombre_completo || "—"}</td>
      <td>${u.rol}</td>
      <td><span class="badge ${u.activo ? "badge-activo" : "badge-inactivo"}">${u.activo ? "Activo" : "Deshabilitado"}</span></td>
      <td>
        ${u.activo
          ? `<button class="link-btn danger" onclick="cambiarEstadoUsuario(${u.id}, false)">Deshabilitar</button>`
          : `<button class="link-btn" onclick="cambiarEstadoUsuario(${u.id}, true)">Habilitar</button>`}
      </td>
    `;
    tbody.appendChild(tr);
  });
}

// ---------------------------------------------------------
// MOSTRAR / OCULTAR CONTRASEÑA
// ---------------------------------------------------------
// Funciona con cualquier botón que tenga data-toggle-password="id-del-input".
document.querySelectorAll('.toggle-password').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.togglePassword);
    if (!input) return;
    const oculto = input.type === 'password';
    input.type = oculto ? 'text' : 'password';
    btn.innerHTML = oculto
      ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
      : '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
    btn.setAttribute('aria-label', oculto ? 'Ocultar contraseña' : 'Mostrar contraseña');
  });
});

// ---------------------------------------------------------
// VALIDACIÓN DE CONTRASEÑA EN TIEMPO REAL
// ---------------------------------------------------------
document.getElementById('user-password').addEventListener('input', function(e) {
  const password = this.value;
  
  // Definir los requisitos
  const requirements = [
    { id: 'length', test: password.length >= 8, message: 'Mínimo 8 caracteres' },
    { id: 'uppercase', test: /[A-Z]/.test(password), message: 'Al menos 1 mayúscula' },
    { id: 'lowercase', test: /[a-z]/.test(password), message: 'Al menos 1 minúscula' },
    { id: 'number', test: /[0-9]/.test(password), message: 'Al menos 1 número' },
    { id: 'special', test: /[!@#$%^&*]/.test(password), message: 'Al menos 1 carácter especial (!@#$%^&*)' },
  ];
  
  let metCount = 0;
  
  // Actualizar cada requisito
  requirements.forEach(req => {
    const container = document.getElementById(`req-${req.id}`);
    const icon = document.getElementById(`req-${req.id}-icon`);
    if (container) {
      if (req.test) {
        container.classList.add('password-requirement-met');
        container.classList.remove('password-requirement-fail');
        if (icon) icon.textContent = '✓';
        metCount++;
      } else if (password.length > 0) {
        container.classList.remove('password-requirement-met');
        container.classList.add('password-requirement-fail');
        if (icon) icon.textContent = '✗';
      } else {
        container.classList.remove('password-requirement-met', 'password-requirement-fail');
        if (icon) icon.textContent = '○';
      }
    }
  });
  
  // Mostrar fortaleza de la contraseña
  const strengthText = document.getElementById('strength-text');
  const segments = document.querySelectorAll('#password-strength .strength-meter-segment');
  const totalReqs = requirements.length;
  const percentage = (metCount / totalReqs) * 100;
  
  // Reiniciar segmentos
  segments.forEach(seg => seg.classList.remove('is-filled-weak', 'is-filled-medium', 'is-filled-strong'));
  
  if (password.length === 0) {
    strengthText.textContent = '—';
    strengthText.className = 'strength-meter-value';
    return;
  }
  
  let strength = '';
  let className = '';
  if (percentage <= 40) {
    strength = 'Débil';
    className = 'password-strength-weak';
  } else if (percentage <= 80) {
    strength = 'Media';
    className = 'password-strength-medium';
  } else {
    strength = 'Fuerte';
    className = 'password-strength-strong';
  }
  
  strengthText.textContent = strength;
  strengthText.className = `strength-meter-value ${className}`;
  
  // Rellenar segmentos proporcionalmente (de 4) según los requisitos cumplidos
  const filledSegments = Math.max(1, Math.round((metCount / totalReqs) * segments.length));
  const segmentFillClass = className.replace('password-strength-', 'is-filled-');
  segments.forEach((seg, i) => {
    if (i < filledSegments) seg.classList.add(segmentFillClass);
  });
});

async function cambiarEstadoUsuario(id, activo) {
  try {
    await api(`/usuarios/${id}`, { method: "PUT", body: JSON.stringify({ activo }) });
    toast(activo ? "Usuario habilitado" : "Usuario deshabilitado");
    cargarUsuarios();
  } catch (e) {
    toast(e.message, true);
  }
}

// ---------------------------------------------------------

// ---------------------------------------------------------
// CONFIGURACIÓN DEL NEGOCIO (solo admin)
// ---------------------------------------------------------
document.getElementById("form-configuracion").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nombre = document.getElementById("cfg-nombre-tienda").value.trim();
  if (!nombre) {
    toast("Escribe el nombre de la tienda", true);
    return;
  }
  try {
    const data = await api("/configuracion", {
      method: "PUT",
      body: JSON.stringify({ nombre_tienda: nombre }),
    });
    aplicarNombreTienda(data.nombre_tienda);
    toast("Configuración guardada");
  } catch (err) {
    toast(err.message || "No se pudo guardar", true);
  }
});

// ---------------------------------------------------------
// NOTIFICACIONES EN TIEMPO REAL (dashboard / campana)
// ---------------------------------------------------------
let _notificaciones = [];
// Claves que ya provocaron un aviso emergente en esta sesión, para no
// estar mostrando el mismo toast cada 30s mientras siga sin descartarse.
let _clavesYaAvisadas = new Set();

async function cargarNotificaciones() {
  try {
    const data = await api("/notificaciones");
    const clavesNuevas = data
      .map((n) => n.clave)
      .filter((c) => !_clavesYaAvisadas.has(c));

    _notificaciones = data;
    _renderNotificaciones();
    _actualizarBadgesNotificaciones();

    if (clavesNuevas.length > 0) {
      const nuevas = data.filter((n) => clavesNuevas.includes(n.clave));
      const urgente = nuevas.some((n) => n.prioridad === "alta");
      const texto = nuevas.length === 1
        ? `🔔 ${nuevas[0].titulo}`
        : `🔔 Tienes ${nuevas.length} notificaciones nuevas`;
      toast(texto, urgente);
      clavesNuevas.forEach((c) => _clavesYaAvisadas.add(c));
    }
  } catch (e) {
    // Sesión expirada u otro error silencioso: no molestar con un toast
    // cada 30 segundos, ya lo maneja api() si es 401.
  }
}

function _actualizarBadgesNotificaciones() {
  const total = _notificaciones.length;
  const hayUrgentes = _notificaciones.some((n) => n.prioridad === "alta");
  const hayAlertas = _notificaciones.some((n) => n.prioridad === "media" || n.prioridad === "alta");

  [document.getElementById("badge-campana"), document.getElementById("badge-notificaciones")].forEach((el) => {
    if (!el) return;
    el.textContent = total > 99 ? "99+" : String(total);
    el.style.display = total > 0 ? "" : "none";
  });

  const campana = document.getElementById("btn-campana");
  if (campana) {
    campana.classList.toggle("tiene-alertas", hayAlertas && !hayUrgentes);
    campana.classList.toggle("tiene-urgentes", hayUrgentes);
  }
}

function _renderNotificaciones() {
  const cont = document.getElementById("lista-notificaciones");
  const vacio = document.getElementById("notificaciones-vacio");
  if (!cont) return;
  cont.innerHTML = "";

  if (_notificaciones.length === 0) {
    vacio.style.display = "";
    return;
  }
  vacio.style.display = "none";

  _notificaciones.forEach((n) => {
    const div = document.createElement("div");
    div.className = `tarjeta-notificacion prioridad-${n.prioridad}`;
    div.dataset.clave = n.clave;
    div.innerHTML = `
      <div class="tarjeta-notificacion-icono">${n.icono}</div>
      <div class="tarjeta-notificacion-cuerpo">
        <h4>${n.titulo}</h4>
        <p>${n.mensaje}</p>
        <div class="tarjeta-notificacion-acciones">
          <button class="btn-notif-ir" data-ir="${n.tab_destino}">${n.texto_boton}</button>
          <button class="btn-notif-quitar" data-quitar="${n.clave}">Quitar notificación</button>
        </div>
      </div>
    `;
    cont.appendChild(div);
  });
}

// Delegación de eventos: los botones de las tarjetas se crean dinámicamente.
document.getElementById("lista-notificaciones").addEventListener("click", (e) => {
  const btnIr = e.target.closest("[data-ir]");
  if (btnIr) {
    const destino = document.querySelector(`.tab-btn[data-tab="${btnIr.dataset.ir}"]`);
    if (destino) destino.click();
    return;
  }
  const btnQuitar = e.target.closest("[data-quitar]");
  if (btnQuitar) _quitarNotificacion(btnQuitar.dataset.quitar);
});

async function _quitarNotificacion(clave) {
  const tarjeta = document.querySelector(`.tarjeta-notificacion[data-clave="${CSS.escape(clave)}"]`);
  if (tarjeta) tarjeta.classList.add("saliendo");
  try {
    await api("/notificaciones/descartar", {
      method: "POST",
      body: JSON.stringify({ clave }),
    });
    _notificaciones = _notificaciones.filter((n) => n.clave !== clave);
    _actualizarBadgesNotificaciones();
    setTimeout(() => {
      if (tarjeta) tarjeta.remove();
      if (_notificaciones.length === 0) document.getElementById("notificaciones-vacio").style.display = "";
    }, 200);
  } catch (err) {
    if (tarjeta) tarjeta.classList.remove("saliendo");
    toast(err.message || "No se pudo quitar la notificación", true);
  }
}

document.getElementById("btn-refrescar-notificaciones").addEventListener("click", async () => {
  await cargarNotificaciones();
  toast("Notificaciones actualizadas");
});

document.getElementById("btn-campana").addEventListener("click", () => {
  const destino = document.querySelector('.tab-btn[data-tab="notificaciones"]');
  if (destino) destino.click();
});


// ---------------------------------------------------------
// RESUMEN DEL DÍA (tarjeta para el dueño / cajero)
// ---------------------------------------------------------
async function cargarResumenDia() {
  const panel = document.getElementById("panel-resumen-dia");
  if (!panel) return;
  try {
    const d = await api("/reportes/resumen-dia");
    document.getElementById("rd-ingresos").textContent = "$" + Number(d.total_ingresos || 0).toFixed(2);
    document.getElementById("rd-ventas").textContent = String(d.num_ventas || 0);
    document.getElementById("rd-ticket").textContent = "$" + Number(d.ticket_promedio || 0).toFixed(2);
    document.getElementById("rd-efectivo").textContent = "$" + Number(d.efectivo || 0).toFixed(2);
    document.getElementById("rd-tarjeta").textContent = "$" + Number(d.tarjeta || 0).toFixed(2);
    document.getElementById("rd-transferencia").textContent = "$" + Number(d.transferencia || 0).toFixed(2);

    const lista = document.getElementById("rd-top-lista");
    const vacio = document.getElementById("rd-top-vacio");
    lista.innerHTML = "";
    if (!d.top_productos || d.top_productos.length === 0) {
      vacio.style.display = "";
    } else {
      vacio.style.display = "none";
      d.top_productos.forEach((p) => {
        const li = document.createElement("li");
        li.textContent = `${p.nombre} — ${p.unidades} uds · $${Number(p.ingresos).toFixed(2)}`;
        lista.appendChild(li);
      });
    }

    const extras = [];
    if (d.productos_bajo_stock > 0) {
      extras.push(`${d.productos_bajo_stock} producto(s) con stock bajo`);
    }
    if (d.ya_hay_corte) {
      extras.push("Ya hay corte de caja registrado hoy");
    } else if (d.num_ventas > 0) {
      extras.push("Aún no se ha hecho el corte de caja de hoy");
    }
    document.getElementById("rd-extra").textContent = extras.join(" · ");
  } catch (e) {
    // Silencioso: si falla no bloqueamos el resto del sistema.
  }
}

const btnResumen = document.getElementById("btn-refrescar-resumen-dia");
if (btnResumen) {
  btnResumen.addEventListener("click", async () => {
    await cargarResumenDia();
    toast("Resumen actualizado");
  });
}

// ---------------------------------------------------------
// CORTE DE CAJA
// ---------------------------------------------------------
let _precorteActual = null;
let _datosCortes = [];

async function cargarPrecorte() {
  const fecha = document.getElementById("corte-fecha").value || fechaHoyLocal();
  try {
    const d = await api(`/caja/precorte?fecha=${fecha}`);
    _precorteActual = d;
    document.getElementById("pc-ventas").textContent = String(d.num_ventas || 0);
    document.getElementById("pc-total").textContent = "$" + Number(d.total_ventas || 0).toFixed(2);
    document.getElementById("pc-efectivo").textContent = "$" + Number(d.total_efectivo || 0).toFixed(2);
    document.getElementById("pc-tarjeta").textContent = "$" + Number(d.total_tarjeta || 0).toFixed(2);
    document.getElementById("pc-transferencia").textContent = "$" + Number(d.total_transferencia || 0).toFixed(2);
    const aviso = document.getElementById("pc-aviso-corte");
    if (d.ya_hay_corte) {
      aviso.style.display = "";
      aviso.textContent = "Ya existe al menos un corte para este día. Puedes registrar otro si hubo un segundo turno.";
    } else {
      aviso.style.display = "none";
      aviso.textContent = "";
    }
    _actualizarPreviewDiferencia();
  } catch (e) {
    toast(e.message || "No se pudo calcular el precorte", true);
  }
}

function _actualizarPreviewDiferencia() {
  const el = document.getElementById("pc-diferencia-preview");
  if (!el) return;
  if (!_precorteActual) {
    el.textContent = "";
    return;
  }
  const contado = parseFloat(document.getElementById("corte-efectivo-contado").value);
  if (isNaN(contado)) {
    el.textContent = `Efectivo esperado según ventas: $${Number(_precorteActual.total_efectivo || 0).toFixed(2)}`;
    return;
  }
  const dif = contado - Number(_precorteActual.total_efectivo || 0);
  if (Math.abs(dif) < 0.005) {
    el.textContent = "Cuadra exacto ✓";
  } else if (dif > 0) {
    el.textContent = `Sobrante: $${dif.toFixed(2)}`;
  } else {
    el.textContent = `Faltante: $${Math.abs(dif).toFixed(2)}`;
  }
}

async function cargarHistorialCortes() {
  try {
    _datosCortes = await api("/caja/cortes?limite=50");
    _renderCortes();
  } catch (e) {
    _datosCortes = [];
    _renderCortes();
  }
}

function _renderCortes() {
  const tbody = document.querySelector("#tabla-cortes tbody");
  if (!tbody) return;
  tbody.innerHTML = "";
  if (!_datosCortes.length) {
    tbody.innerHTML = `<tr><td colspan="11">Aún no hay cortes registrados</td></tr>`;
    return;
  }
  _recortarPorLimite(_datosCortes, "limite-cortes").forEach((c) => {
    const tr = document.createElement("tr");
    const dia = c.fecha_corte ? new Date(c.fecha_corte).toLocaleDateString() : "—";
    const dif = Number(c.diferencia || 0);
    let difTxt = "$" + dif.toFixed(2);
    if (dif > 0.005) difTxt = "+" + difTxt + " sobrante";
    else if (dif < -0.005) difTxt = difTxt + " faltante";
    else difTxt = "$0.00";
    // Cortes antiguos pueden no traer efectivo_esperado: se usa total_efectivo.
    const esperado = c.efectivo_esperado != null
      ? Number(c.efectivo_esperado)
      : Number(c.total_efectivo || 0);
    tr.innerHTML = `
      <td>${dia}</td>
      <td>${c.num_ventas}</td>
      <td>$${Number(c.total_ventas || 0).toFixed(2)}</td>
      <td>$${Number(c.total_compras || 0).toFixed(2)}</td>
      <td>$${Number(c.total_mermas || 0).toFixed(2)}</td>
      <td>$${Number(c.total_otros_gastos || 0).toFixed(2)}</td>
      <td>$${esperado.toFixed(2)}</td>
      <td>$${Number(c.efectivo_contado || 0).toFixed(2)}</td>
      <td>${difTxt}</td>
      <td>${c.registrado_por || "—"}</td>
      <td>${c.notas || ""}</td>
    `;
    tbody.appendChild(tr);
  });
}

async function cargarCorteCaja() {
  if (!document.getElementById("corte-fecha").value) {
    document.getElementById("corte-fecha").value = fechaHoyLocal();
  }
  await cargarPrecorte();
  await cargarHistorialCortes();
}

document.getElementById("btn-cargar-precorte")?.addEventListener("click", cargarPrecorte);
document.getElementById("corte-efectivo-contado")?.addEventListener("input", _actualizarPreviewDiferencia);
document.getElementById("limite-cortes")?.addEventListener("change", _renderCortes);

document.getElementById("form-corte-caja")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const fecha = document.getElementById("corte-fecha").value || fechaHoyLocal();
  const efectivo_contado = parseFloat(document.getElementById("corte-efectivo-contado").value);
  if (isNaN(efectivo_contado) || efectivo_contado < 0) {
    toast("Indica el efectivo contado", true);
    return;
  }
  const notas = document.getElementById("corte-notas").value || "";
  try {
    const corte = await api("/caja/cortes", {
      method: "POST",
      body: JSON.stringify({ fecha_corte: fecha, efectivo_contado, notas }),
    });
    const dif = Number(corte.diferencia || 0);
    let msg = "Corte guardado";
    if (dif > 0.005) msg += ` · sobrante $${dif.toFixed(2)}`;
    else if (dif < -0.005) msg += ` · faltante $${Math.abs(dif).toFixed(2)}`;
    else msg += " · cuadra exacto";
    toast(msg);
    document.getElementById("corte-efectivo-contado").value = "";
    document.getElementById("corte-notas").value = "";
    await cargarCorteCaja();
    cargarResumenDia();
  } catch (err) {
    toast(err.message || "No se pudo guardar el corte", true);
  }
});

// ---------------------------------------------------------
// FECHAS POR DEFECTO EN FILTROS (hoy en Desde y Hasta)
// ---------------------------------------------------------
function fechaHoyLocal() {
  // Fecha de hoy en zona local, formato YYYY-MM-DD (para inputs type="date").
  // No usamos toISOString() porque es UTC y puede cambiar el día.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function inicializarFiltrosFecha() {
  const hoy = fechaHoyLocal();
  [
    "mov-fecha-inicio",
    "mov-fecha-fin",
    "gasto-fecha-inicio",
    "gasto-fecha-fin",
    "rep-fecha-inicio",
    "rep-fecha-fin",
    "corte-fecha",
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = hoy;
  });
  // También la fecha del formulario de registrar gasto.
  const gastoFecha = document.getElementById("gasto-fecha");
  if (gastoFecha && !gastoFecha.value) gastoFecha.value = hoy;
}

// Arranque
// ---------------------------------------------------------
inicializarFiltrosFecha();
cargarConfiguracionPublica();
cargarSesionGuardada();
