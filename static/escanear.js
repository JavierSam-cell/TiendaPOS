const API = "/api";
// Mismas llaves de localStorage que usa app.js.
let sesion = { token: null, usuario: null };
let permisosEfectivos = {};

// Carrito LOCAL de la venta desde el celular (independiente del de la PC).
let carritoEsc = []; // [{codigo_barras, nombre, precio, cantidad, stock, unidad_venta}]

function tienePermiso(...claves) {
  if (!sesion.usuario) return false;
  if (sesion.usuario.rol === "admin") return true;
  return claves.some((c) => !!permisosEfectivos[c]);
}

async function cargarPermisos() {
  if (!sesion.usuario || sesion.usuario.rol === "admin") {
    permisosEfectivos = {};
    return;
  }
  try {
    permisosEfectivos = await api("/permisos/mias");
  } catch (e) {
    permisosEfectivos = {};
  }
}

function toast(msg, isError = false) {
  const t = document.getElementById("toast-esc");
  t.textContent = msg;
  t.className = "show" + (isError ? " error" : "");
  setTimeout(() => (t.className = ""), 2200);
}

let _audioCtxBeep = null;
function sonidoBeepEscaneo() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!_audioCtxBeep) _audioCtxBeep = new AudioCtx();
    if (_audioCtxBeep.state === "suspended") _audioCtxBeep.resume();
    const ctx = _audioCtxBeep;
    const ahora = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(1800, ahora);
    gain.gain.setValueAtTime(0.0001, ahora);
    gain.gain.exponentialRampToValueAtTime(0.22, ahora + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, ahora + 0.09);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(ahora);
    osc.stop(ahora + 0.1);
  } catch (e) { /* ignore */ }
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (sesion.token) headers["Authorization"] = "Bearer " + sesion.token;
  const res = await fetch(API + path, { headers, ...options });
  if (res.status === 401) {
    cerrarSesionLocal();
    toast("Tu sesión expiró, entra de nuevo", true);
    throw new Error("No autenticado");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || "Error en la petición");
  return data;
}

// ---------------------------------------------------------
// LOGIN / SESIÓN
// ---------------------------------------------------------
async function cargarSesionGuardada() {
  const token = localStorage.getItem("pos_token");
  const usuario = localStorage.getItem("pos_usuario");
  if (token && usuario) {
    sesion.token = token;
    sesion.usuario = JSON.parse(usuario);
    await cargarPermisos();
    mostrarPantallaScan();
  } else {
    // Sin sesión: al login principal (una sola pantalla de acceso).
    window.location.replace("/");
  }
}

function cerrarSesionLocal() {
  localStorage.removeItem("pos_token");
  localStorage.removeItem("pos_usuario");
  sesion = { token: null, usuario: null };
  carritoEsc = [];
  try { detenerEscaneoSiActivo(); } catch (_) {}
  // Siempre al login principal del POS (/), no al login embebido de /escanear.
  window.location.replace("/");
}

function mostrarPantallaLogin() {
  document.getElementById("esc-pantalla-login").style.display = "block";
  document.getElementById("esc-pantalla-scan").style.display = "none";
}

function mostrarPantallaScan() {
  document.getElementById("esc-pantalla-login").style.display = "none";
  document.getElementById("esc-pantalla-scan").style.display = "block";
  document.getElementById("esc-nombre-usuario").textContent =
    sesion.usuario.nombre_completo || sesion.usuario.username;
  cargarCatalogoEsc();
  renderCarritoEsc();
}

document.getElementById("esc-form-login").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = document.getElementById("esc-usuario").value.trim();
  const password = document.getElementById("esc-password").value;
  const errorEl = document.getElementById("esc-login-error");
  errorEl.textContent = "";
  try {
    const res = await fetch(API + "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || "Usuario o contraseña incorrectos");
    sesion.token = data.token;
    sesion.usuario = data.usuario;
    localStorage.setItem("pos_token", data.token);
    localStorage.setItem("pos_usuario", JSON.stringify(data.usuario));
    await cargarPermisos();
    mostrarPantallaScan();
  } catch (err) {
    errorEl.textContent = err.message || "No se pudo iniciar sesión";
  }
});

document.getElementById("esc-btn-salir").addEventListener("click", () => {
  cerrarSesionLocal();
});

// ---------------------------------------------------------
// ESCÁNER → envía solo el código a la PC (puente remoto)
// ---------------------------------------------------------
const FORMATOS_CODIGO_BARRAS = [
  "ean_13", "ean_8", "upc_a", "upc_e",
  "code_128", "code_39", "code_93", "codabar", "itf", "qr_code",
];
// Varios recortes centrados con distinto "zoom": códigos grandes se leen
// con el recorte amplio; códigos chiquitos (mayonesa, sobres, etc.) con
// el recorte más cerrado + ampliado digitalmente.
const RECORTES_ESCANEO = [
  { ancho: 0.88, alto: 0.34 }, // amplio
  { ancho: 0.62, alto: 0.26 }, // medio
  { ancho: 0.40, alto: 0.20 }, // zoom fuerte (códigos pequeños)
  { ancho: 0.28, alto: 0.16 }, // zoom máximo
];
// Tras aceptar un código, ignora el MISMO un momento (evita spam) pero
// deja la cámara abierta para el siguiente producto de inmediato.
const COOLDOWN_MISMO_CODIGO_MS = 2500;

let _stream = null;
let _detenido = true;

function checksumEanUpcValido(codigo) {
  const limpio = String(codigo || "").replace(/\s+/g, "");
  if (!/^\d{8}$|^\d{12}$|^\d{13}$/.test(limpio)) return true;
  const cuerpo = limpio.slice(0, -1).split("").map(Number);
  const checkEsperado = Number(limpio.slice(-1));
  let suma = 0;
  cuerpo.forEach((d, i) => {
    const posDesdeDerecha = cuerpo.length - i;
    suma += d * (posDesdeDerecha % 2 === 1 ? 3 : 1);
  });
  const checkCalculado = (10 - (suma % 10)) % 10;
  return checkCalculado === checkEsperado;
}

function distanciaAlCentro(codigo, cx, cy) {
  const caja = codigo.boundingBox;
  if (!caja) return 0;
  const codX = caja.x + caja.width / 2;
  const codY = caja.y + caja.height / 2;
  return (codX - cx) ** 2 + (codY - cy) ** 2;
}

/** Dibuja un recorte centrado del video ampliado y con un toque de contraste. */
function prepararRecorte(video, canvas, ctx, fracAncho, fracAlto) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const anchoRecorte = vw * fracAncho;
  const altoRecorte = vh * fracAlto;
  const xRecorte = (vw - anchoRecorte) / 2;
  const yRecorte = (vh - altoRecorte) / 2;
  // Amplía el recorte para que barras finas (códigos chicos) tengan más píxeles.
  const escala = Math.min(5, Math.max(1.2, 1100 / anchoRecorte));
  canvas.width = Math.round(anchoRecorte * escala);
  canvas.height = Math.round(altoRecorte * escala);
  ctx.imageSmoothingEnabled = false;
  ctx.filter = "contrast(1.25) brightness(1.05)";
  ctx.drawImage(
    video,
    xRecorte, yRecorte, anchoRecorte, altoRecorte,
    0, 0, canvas.width, canvas.height
  );
  ctx.filter = "none";
}

function detenerEscaneoSiActivo() {
  _detenido = true;
  if (_stream) {
    _stream.getTracks().forEach((t) => t.stop());
    _stream = null;
  }
  document.getElementById("esc-video-wrap").classList.remove("mostrar");
  document.getElementById("esc-video-contenedor").innerHTML = "";
  const btn = document.getElementById("btn-esc-scan");
  btn.classList.remove("escaneando");
  document.getElementById("btn-esc-scan-txt").textContent = "Escanear → enviar a la PC";
  document.querySelectorAll(".esc-linterna").forEach((b) => b.remove());
}

function iniciarEscaneo() {
  const wrap = document.getElementById("esc-video-wrap");
  const contenedor = document.getElementById("esc-video-contenedor");
  contenedor.innerHTML = "";
  wrap.classList.add("mostrar");

  const btn = document.getElementById("btn-esc-scan");
  btn.classList.add("escaneando");
  document.getElementById("btn-esc-scan-txt").textContent = "Cancelar (sigue escaneando…)";

  const video = document.createElement("video");
  video.setAttribute("playsinline", "");
  video.setAttribute("muted", "");
  video.muted = true;
  contenedor.appendChild(video);

  const canvasRecorte = document.createElement("canvas");
  const ctxRecorte = canvasRecorte.getContext("2d", { willReadFrequently: true });
  const detector = new BarcodeDetector({ formats: FORMATOS_CODIGO_BARRAS });

  _detenido = false;

  navigator.mediaDevices
    .getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        // Ayuda en celulares que lo soportan: más detalle cerca del código.
        advanced: [{ focusMode: "continuous" }],
      },
    })
    .then((s) => {
      _stream = s;
      video.srcObject = s;
      video.play();

      const [pista] = s.getVideoTracks();
      const capacidades = pista.getCapabilities ? pista.getCapabilities() : {};
      if (capacidades.focusMode && capacidades.focusMode.includes("continuous")) {
        pista.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
      }
      // Zoom óptico/digital de la cámara si existe (mejor que solo zoom por software).
      if (capacidades.zoom) {
        const zMin = capacidades.zoom.min || 1;
        const zMax = capacidades.zoom.max || 1;
        const zIdeal = Math.min(zMax, Math.max(zMin, 1.5));
        pista.applyConstraints({ advanced: [{ zoom: zIdeal }] }).catch(() => {});
      }
      if (capacidades.torch) {
        const btnLinterna = document.createElement("button");
        btnLinterna.type = "button";
        btnLinterna.className = "esc-linterna";
        btnLinterna.textContent = "🔦";
        let encendida = false;
        btnLinterna.addEventListener("click", () => {
          encendida = !encendida;
          pista.applyConstraints({ advanced: [{ torch: encendida }] }).catch(() => {});
          btnLinterna.classList.toggle("activa", encendida);
        });
        wrap.appendChild(btnLinterna);
      }

      let ultimoCandidato = null;
      let vecesSeguidas = 0;
      let ultimoAceptado = null;
      let ultimoAceptadoTs = 0;
      let indiceRecorte = 0;
      // Evita encolar muchos detect() si el navegador va lento.
      let detectando = false;

      const aceptarCodigo = (valor) => {
        const ahora = Date.now();
        // Mismo código dentro del cooldown → se ignora (evita doble envío
        // si sigues apuntando al mismo producto un segundo o dos).
        if (valor === ultimoAceptado && ahora - ultimoAceptadoTs < COOLDOWN_MISMO_CODIGO_MS) {
          return false;
        }
        ultimoAceptado = valor;
        ultimoAceptadoTs = ahora;
        ultimoCandidato = null;
        vecesSeguidas = 0;
        // NO apaga la cámara: listo para el siguiente producto.
        enviarCodigoAComputadora(valor);
        return true;
      };

      const enCooldownMismo = (valor) => {
        if (!valor || valor !== ultimoAceptado) return false;
        return Date.now() - ultimoAceptadoTs < COOLDOWN_MISMO_CODIGO_MS;
      };

      const detectarCuadro = async () => {
        if (_detenido) return;
        if (!video.videoWidth) {
          requestAnimationFrame(detectarCuadro);
          return;
        }
        if (detectando) {
          requestAnimationFrame(detectarCuadro);
          return;
        }
        detectando = true;

        try {
          // Alterna el nivel de zoom cada cuadro: cubre códigos grandes y chicos
          // sin hacer 4 detecciones en el mismo frame (más fluido en el celular).
          const recorte = RECORTES_ESCANEO[indiceRecorte % RECORTES_ESCANEO.length];
          indiceRecorte++;
          prepararRecorte(video, canvasRecorte, ctxRecorte, recorte.ancho, recorte.alto);

          let codigos = [];
          try {
            codigos = await detector.detect(canvasRecorte);
          } catch (_) {
            codigos = [];
          }

          if (_detenido) return;

          const validos = codigos
            .map((c) => ({ ...c, rawValue: String(c.rawValue || "").replace(/\s+/g, "") }))
            .filter((c) => c.rawValue && checksumEanUpcValido(c.rawValue));

          if (validos.length === 0) {
            // Si este zoom falló, no reinicia el contador de otro candidato
            // de un zoom anterior en el mismo segundo: solo baja un poco.
            if (vecesSeguidas > 0) vecesSeguidas = Math.max(0, vecesSeguidas - 1);
          } else {
            const cx = canvasRecorte.width / 2;
            const cy = canvasRecorte.height / 2;
            validos.sort((a, b) => distanciaAlCentro(a, cx, cy) - distanciaAlCentro(b, cx, cy));
            const elegido = validos[0];

            // Si es el mismo que acabamos de mandar, ni lo contamos.
            if (enCooldownMismo(elegido.rawValue)) {
              ultimoCandidato = null;
              vecesSeguidas = 0;
            } else if (elegido.rawValue === ultimoCandidato) {
              vecesSeguidas++;
            } else {
              ultimoCandidato = elegido.rawValue;
              vecesSeguidas = 1;
            }

            // 2 lecturas seguidas del mismo código = más estable, menos dobles.
            if (vecesSeguidas >= 2) {
              aceptarCodigo(elegido.rawValue);
            }
          }
        } finally {
          detectando = false;
          if (!_detenido) requestAnimationFrame(detectarCuadro);
        }
      };
      requestAnimationFrame(detectarCuadro);
    })
    .catch((err) => {
      toast("No se pudo acceder a la cámara: " + err, true);
      detenerEscaneoSiActivo();
    });
}

document.getElementById("btn-esc-scan").addEventListener("click", () => {
  if (_detenido) iniciarEscaneo();
  else detenerEscaneoSiActivo();
});

/** Envía el código a la computadora (puente remoto). No toca el carrito local. */
async function enviarCodigoAComputadora(codigo) {
  try {
    await api("/escaneo-remoto", {
      method: "POST",
      body: JSON.stringify({ codigo_barras: codigo }),
    });
    sonidoBeepEscaneo();
    if (navigator.vibrate) navigator.vibrate(60);
    const ultimo = document.getElementById("esc-ultimo");
    document.getElementById("esc-ultimo-codigo").textContent = codigo;
    ultimo.classList.add("mostrar");
    setTimeout(() => ultimo.classList.remove("mostrar"), 3000);
    // Si no existe, ofrece alta rápida aquí.
    revisarCodigoLocal(codigo);
  } catch (err) {
    toast(err.message || "No se pudo enviar el código", true);
  }
}

async function revisarCodigoLocal(codigo) {
  ocultarNoEncontrado();
  try {
    await api(`/productos/codigo/${encodeURIComponent(codigo)}`);
  } catch (err) {
    if (err.message.includes("no encontrado") || err.message.includes("Producto no")) {
      mostrarNoEncontrado(codigo);
    }
  }
}

async function mostrarNoEncontrado(codigo) {
  const panel = document.getElementById("esc-no-encontrado");
  const texto = document.getElementById("esc-texto-no-encontrado");
  const form = document.getElementById("esc-form-alta-rapida");
  panel.style.display = "block";

  if (tienePermiso("productos.agregar")) {
    texto.textContent = `El código "${codigo}" no está registrado. Buscando en internet...`;
    document.getElementById("esc-rapido-codigo").value = codigo;
    document.getElementById("esc-rapido-nombre").value = "";
    document.getElementById("esc-rapido-precio").value = "";
    document.getElementById("esc-rapido-stock").value = 1;
    form.style.display = "block";

    try {
      const resultado = await api(`/productos/buscar-web/${encodeURIComponent(codigo)}`);
      if (resultado.encontrado) {
        document.getElementById("esc-rapido-nombre").value = resultado.nombre;
        texto.textContent = `El código "${codigo}" no está registrado. Encontramos este producto en internet, revisa el nombre y completa el precio:`;
      } else {
        texto.textContent = `El código "${codigo}" no está registrado y no lo encontramos en internet. Dalo de alta manualmente:`;
      }
    } catch (e) {
      texto.textContent = `El código "${codigo}" no está registrado (sin conexión a internet para buscarlo). Dalo de alta manualmente:`;
    }
  } else {
    texto.textContent = `El código "${codigo}" no está registrado. Pide a un administrador que lo dé de alta.`;
    form.style.display = "none";
  }
}

function ocultarNoEncontrado() {
  document.getElementById("esc-no-encontrado").style.display = "none";
}

document.getElementById("esc-btn-cancelar-alta-rapida").addEventListener("click", ocultarNoEncontrado);

document.getElementById("esc-form-alta-rapida").addEventListener("submit", async (e) => {
  e.preventDefault();
  const codigo = document.getElementById("esc-rapido-codigo").value;
  const payload = {
    codigo_barras: codigo,
    nombre: document.getElementById("esc-rapido-nombre").value,
    precio_venta: parseFloat(document.getElementById("esc-rapido-precio").value),
    stock: parseInt(document.getElementById("esc-rapido-stock").value || 1),
  };
  try {
    await api("/productos", { method: "POST", body: JSON.stringify(payload) });
    toast("Producto dado de alta");
    ocultarNoEncontrado();
    cargarCatalogoEsc();
    // Se vuelve a mandar a la PC para que lo use en Vender/Inventario.
    await enviarCodigoAComputadora(codigo);
  } catch (err) {
    toast(err.message || "No se pudo dar de alta el producto", true);
  }
});

// ---------------------------------------------------------
// BÚSQUEDA → venta LOCAL en el celular
// ---------------------------------------------------------
function normalizarTexto(texto) {
  return (texto || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

const LIMITE_BUSQUEDA_ESC = 12;
let _catalogoEsc = [];

async function cargarCatalogoEsc() {
  try {
    _catalogoEsc = await api("/productos?activos=true");
  } catch (e) {
    _catalogoEsc = [];
  }
}

function _resultadosBusquedaEsc(texto) {
  const termino = normalizarTexto((texto || "").trim());
  if (!termino) return [];
  return _catalogoEsc.filter((p) =>
    normalizarTexto(p.nombre).includes(termino) ||
    normalizarTexto(p.codigo_barras || "").includes(termino)
  );
}

function _pareceCodigoBarrasEsc(texto) {
  const t = (texto || "").trim();
  if (t.length < 4) return false;
  if (/\s/.test(t)) return false;
  return /^[0-9]{6,}$/.test(t) || /^INT-[0-9A-F]+$/i.test(t);
}

const UNIDADES_INFO_ESC = {
  pieza:   { label: "Pieza", corto: "pza", tipo: "entera", step: 1, presets: [1, 2, 3, 5], precioSufijo: "" },
  kg:      { label: "Kilogramo", corto: "kg", tipo: "continua", step: 0.001, presets: null, precioSufijo: "/kg",
             sub: { menor: { id: "g", label: "Gramos", factor: 1000, step: 1, presets: [100, 150, 200, 250] },
                    mayor: { id: "kg", label: "Kilos", factor: 1, step: 0.1, presets: [0.5, 1, 1.5, 2] } } },
  litro:   { label: "Litro", corto: "L", tipo: "continua", step: 0.001, presets: null, precioSufijo: "/L",
             sub: { menor: { id: "ml", label: "ml", factor: 1000, step: 10, presets: [250, 500, 750, 1000] },
                    mayor: { id: "L", label: "Litros", factor: 1, step: 0.1, presets: [0.5, 1, 1.5, 2] } } },
  caja:    { label: "Caja", corto: "caja", tipo: "media", step: 0.5, presets: [0.5, 1, 2, 3], precioSufijo: "" },
  paquete: { label: "Paquete", corto: "paq", tipo: "media", step: 0.5, presets: [0.5, 1, 2, 3], precioSufijo: "" },
  bolsa:   { label: "Bolsa", corto: "bolsa", tipo: "media", step: 0.5, presets: [0.5, 1, 2, 3], precioSufijo: "" },
};
function infoUnidadEsc(u) { return UNIDADES_INFO_ESC[u] || UNIDADES_INFO_ESC.pieza; }
function esUnidadContinuaEsc(u) { return infoUnidadEsc(u).tipo === "continua"; }
function sufijoPrecioEsc(u) { return infoUnidadEsc(u).precioSufijo || ""; }

function formatearCantidadEsc(cantidad, unidadVenta) {
  const u = unidadVenta || "pieza";
  const n = Number(cantidad) || 0;
  if (u === "kg") return n < 1 ? `${Math.round(n * 1000)} g` : `${Number(n.toFixed(3))} kg`;
  if (u === "litro") return n < 1 ? `${Math.round(n * 1000)} ml` : `${Number(n.toFixed(3))} L`;
  if (u === "caja" || u === "paquete" || u === "bolsa") {
    const et = n === 1 ? infoUnidadEsc(u).label.toLowerCase()
      : (u === "caja" ? "cajas" : u === "paquete" ? "paquetes" : "bolsas");
    return `${Number(n.toFixed(2))} ${et}`;
  }
  return String(n);
}

function renderResultadosBusquedaEsc(productos) {
  const cont = document.getElementById("esc-buscar-resultados");
  const vacio = document.getElementById("esc-buscar-vacio");
  cont.innerHTML = "";

  if (productos.length === 0) {
    vacio.style.display = "block";
    return;
  }
  vacio.style.display = "none";

  productos.forEach((p) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "esc-resultado-item";
    const precioTexto = `$${Number(p.precio_venta).toFixed(2)}${sufijoPrecioEsc(p.unidad_venta)}`;
    btn.innerHTML = `
      <span>
        <span class="esc-resultado-nombre">${p.nombre}</span><br>
        <span class="esc-resultado-codigo">${p.requiere_codigo === false ? "sin código" : p.codigo_barras}</span>
      </span>
      <span class="esc-resultado-precio">${precioTexto}</span>
    `;
    btn.addEventListener("click", () => {
      document.getElementById("esc-buscar-input").value = "";
      renderResultadosBusquedaEsc([]);
      document.getElementById("esc-buscar-vacio").style.display = "none";
      // Venta local: pide cantidad y agrega al ticket del celular.
      elegirProductoParaTicket(p);
    });
    cont.appendChild(btn);
  });
}

function filtrarBusquedaEsc(texto) {
  const crudo = (texto || "").trim();
  if (!crudo) {
    document.getElementById("esc-buscar-resultados").innerHTML = "";
    document.getElementById("esc-buscar-vacio").style.display = "none";
    return;
  }
  const filtrados = _resultadosBusquedaEsc(crudo).slice(0, LIMITE_BUSQUEDA_ESC);
  renderResultadosBusquedaEsc(filtrados);
}

async function resolverBusquedaEscConEnter() {
  const input = document.getElementById("esc-buscar-input");
  const crudo = (input.value || "").trim();
  if (!crudo) return;

  const porCodigo = _catalogoEsc.find(
    (p) => (p.codigo_barras || "").toLowerCase() === crudo.toLowerCase()
  );
  if (porCodigo) {
    input.value = "";
    filtrarBusquedaEsc("");
    elegirProductoParaTicket(porCodigo);
    return;
  }

  // Código de barras que no está en catálogo: se manda a la PC (como el escáner).
  if (_pareceCodigoBarrasEsc(crudo)) {
    input.value = "";
    filtrarBusquedaEsc("");
    await enviarCodigoAComputadora(crudo);
    return;
  }

  const resultados = _resultadosBusquedaEsc(crudo);
  if (resultados.length === 1) {
    input.value = "";
    filtrarBusquedaEsc("");
    elegirProductoParaTicket(resultados[0]);
    return;
  }

  if (resultados.length === 0) {
    toast("No se encontró ese producto", true);
  } else {
    toast(`Hay ${resultados.length} resultados: toca uno de la lista`);
  }
}

document.getElementById("esc-buscar-input").addEventListener("input", (e) => {
  filtrarBusquedaEsc(e.target.value);
});
document.getElementById("esc-buscar-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    resolverBusquedaEscConEnter();
  }
});

// ---------------------------------------------------------
// Modal de cantidad → agrega al CARRITO LOCAL
// ---------------------------------------------------------
let _escProductoModal = null;
let _escIdxEdicion = null;
let _escUnidadModal = "base";
let _escUnidadProducto = "pieza";

function _escCantidadBaseDesdeInput() {
  const valor = parseFloat(document.getElementById("esc-mcr-cantidad").value) || 0;
  const info = infoUnidadEsc(_escUnidadProducto);
  if (info.tipo === "continua" && info.sub) {
    if (_escUnidadModal === info.sub.menor.id) return valor / info.sub.menor.factor;
    return valor;
  }
  return valor;
}

function elegirProductoParaTicket(producto, idxExistente = null) {
  if (!producto || producto.activo === false) {
    toast("Ese producto no está disponible", true);
    return;
  }
  abrirModalCantidadEsc(producto, idxExistente);
}

function abrirModalCantidadEsc(producto, idxExistente = null) {
  _escProductoModal = producto;
  _escIdxEdicion = idxExistente;
  _escUnidadProducto = producto.unidad_venta || "pieza";
  const info = infoUnidadEsc(_escUnidadProducto);
  const continua = info.tipo === "continua";

  document.getElementById("esc-mcr-nombre").textContent = producto.nombre;
  document.getElementById("esc-mcr-precio-label").textContent = continua
    ? `Precio: $${Number(producto.precio_venta).toFixed(2)} por ${info.label.toLowerCase()}`
    : `Precio: $${Number(producto.precio_venta).toFixed(2)} c/u`;

  const cantidadPrevia = idxExistente !== null
    ? carritoEsc[idxExistente].cantidad
    : (continua ? 0.1 : 1);

  const toggle = document.getElementById("esc-mcr-toggle-unidad");
  if (continua && info.sub) {
    toggle.style.display = "flex";
    document.getElementById("esc-mcr-btn-subunidad").textContent = info.sub.menor.label;
    document.getElementById("esc-mcr-btn-unidad-base").textContent = info.sub.mayor.label;
    _escUnidadModal = cantidadPrevia >= 0.5 ? info.sub.mayor.id : info.sub.menor.id;
    _escConfigurarUnidadModal(cantidadPrevia);
  } else {
    toggle.style.display = "none";
    _escUnidadModal = "base";
    const input = document.getElementById("esc-mcr-cantidad");
    const sufijo = document.getElementById("esc-mcr-sufijo-unidad");
    const presets = document.getElementById("esc-mcr-presets");
    presets.innerHTML = "";
    sufijo.textContent = info.corto;
    input.step = String(info.step);
    input.min = String(info.step);
    input.value = cantidadPrevia;
    (info.presets || []).forEach((val) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn-secondary";
      b.textContent = formatearCantidadEsc(val, _escUnidadProducto);
      b.addEventListener("click", () => {
        input.value = val;
        actualizarSubtotalModalEsc();
      });
      presets.appendChild(b);
    });
  }
  actualizarSubtotalModalEsc();
  document.getElementById("esc-modal-cantidad").style.display = "flex";
  setTimeout(() => {
    const inp = document.getElementById("esc-mcr-cantidad");
    inp.focus();
    inp.select();
  }, 50);
}

function _escConfigurarUnidadModal(cantidadBase) {
  const input = document.getElementById("esc-mcr-cantidad");
  const sufijo = document.getElementById("esc-mcr-sufijo-unidad");
  const btnMenor = document.getElementById("esc-mcr-btn-subunidad");
  const btnMayor = document.getElementById("esc-mcr-btn-unidad-base");
  const presets = document.getElementById("esc-mcr-presets");
  const info = infoUnidadEsc(_escUnidadProducto);
  if (!info.sub) return;
  const esMenor = _escUnidadModal === info.sub.menor.id;
  btnMenor.classList.toggle("activo", esMenor);
  btnMayor.classList.toggle("activo", !esMenor);
  presets.innerHTML = "";
  const sub = esMenor ? info.sub.menor : info.sub.mayor;
  sufijo.textContent = sub.id;
  input.step = String(sub.step);
  input.min = String(sub.step);
  input.value = esMenor ? Math.round(cantidadBase * sub.factor) : Math.round(cantidadBase * 10) / 10;
  (sub.presets || []).forEach((val) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "btn-secondary";
    b.textContent = `${val} ${sub.id}`;
    b.addEventListener("click", () => {
      input.value = val;
      actualizarSubtotalModalEsc();
    });
    presets.appendChild(b);
  });
}

function actualizarSubtotalModalEsc() {
  if (!_escProductoModal) return;
  const cantidad = _escCantidadBaseDesdeInput();
  const subtotal = cantidad * Number(_escProductoModal.precio_venta || 0);
  document.getElementById("esc-mcr-subtotal").textContent = subtotal.toFixed(2);
}

function _escPasoModal() {
  const info = infoUnidadEsc(_escUnidadProducto);
  if (info.tipo === "continua" && info.sub) {
    if (_escUnidadModal === info.sub.menor.id) return info.sub.menor.step * 10;
    return 0.5;
  }
  return info.step || 1;
}

document.getElementById("esc-mcr-btn-subunidad").addEventListener("click", () => {
  const info = infoUnidadEsc(_escUnidadProducto);
  if (!info.sub || _escUnidadModal === info.sub.menor.id) return;
  const base = _escCantidadBaseDesdeInput();
  _escUnidadModal = info.sub.menor.id;
  _escConfigurarUnidadModal(base);
  actualizarSubtotalModalEsc();
});
document.getElementById("esc-mcr-btn-unidad-base").addEventListener("click", () => {
  const info = infoUnidadEsc(_escUnidadProducto);
  if (!info.sub || _escUnidadModal === info.sub.mayor.id) return;
  const base = _escCantidadBaseDesdeInput();
  _escUnidadModal = info.sub.mayor.id;
  _escConfigurarUnidadModal(base);
  actualizarSubtotalModalEsc();
});
document.getElementById("esc-mcr-cantidad").addEventListener("input", actualizarSubtotalModalEsc);
document.getElementById("esc-mcr-menos").addEventListener("click", () => {
  const input = document.getElementById("esc-mcr-cantidad");
  const paso = _escPasoModal();
  const nuevo = Math.max(paso, (parseFloat(input.value) || 0) - paso);
  const info = infoUnidadEsc(_escUnidadProducto);
  if (info.tipo === "media") input.value = Math.round(nuevo * 2) / 2;
  else if (info.tipo === "continua" && info.sub && _escUnidadModal === info.sub.mayor.id)
    input.value = Math.round(nuevo * 10) / 10;
  else input.value = Math.round(nuevo * 1000) / 1000;
  actualizarSubtotalModalEsc();
});
document.getElementById("esc-mcr-mas").addEventListener("click", () => {
  const input = document.getElementById("esc-mcr-cantidad");
  const paso = _escPasoModal();
  const nuevo = (parseFloat(input.value) || 0) + paso;
  const info = infoUnidadEsc(_escUnidadProducto);
  if (info.tipo === "media") input.value = Math.round(nuevo * 2) / 2;
  else if (info.tipo === "continua" && info.sub && _escUnidadModal === info.sub.mayor.id)
    input.value = Math.round(nuevo * 10) / 10;
  else input.value = Math.round(nuevo * 1000) / 1000;
  actualizarSubtotalModalEsc();
});
document.getElementById("esc-mcr-cancelar").addEventListener("click", () => {
  document.getElementById("esc-modal-cantidad").style.display = "none";
  _escProductoModal = null;
  _escIdxEdicion = null;
});
document.getElementById("esc-mcr-agregar").addEventListener("click", () => {
  const cantidad = _escCantidadBaseDesdeInput();
  if (!cantidad || cantidad <= 0) {
    toast("Ingresa una cantidad válida", true);
    return;
  }
  const p = _escProductoModal;
  if (p.stock != null && cantidad > p.stock) {
    toast(`No hay suficiente stock (disponible: ${formatearCantidadEsc(p.stock, p.unidad_venta)})`, true);
    return;
  }
  if (_escIdxEdicion !== null) {
    carritoEsc[_escIdxEdicion].cantidad = cantidad;
  } else {
    const existente = carritoEsc.find((i) => i.codigo_barras === p.codigo_barras);
    if (existente) {
      const nueva = existente.cantidad + cantidad;
      if (p.stock != null && nueva > p.stock) {
        toast(`No hay suficiente stock (disponible: ${formatearCantidadEsc(p.stock, p.unidad_venta)})`, true);
        return;
      }
      existente.cantidad = nueva;
      existente.stock = p.stock;
    } else {
      carritoEsc.push({
        codigo_barras: p.codigo_barras,
        nombre: p.nombre,
        precio: p.precio_venta,
        cantidad,
        stock: p.stock,
        unidad_venta: p.unidad_venta || "pieza",
      });
    }
  }
  document.getElementById("esc-modal-cantidad").style.display = "none";
  _escProductoModal = null;
  _escIdxEdicion = null;
  renderCarritoEsc();
  sonidoBeepEscaneo();
  toast(`${p.nombre} agregado al ticket`);
});

function renderCarritoEsc() {
  const lista = document.getElementById("esc-carrito-lista");
  const vacio = document.getElementById("esc-carrito-vacio");
  const btnCobrar = document.getElementById("esc-btn-cobrar");
  lista.innerHTML = "";
  let total = 0;

  if (carritoEsc.length === 0) {
    vacio.style.display = "block";
    btnCobrar.disabled = true;
    document.getElementById("esc-total-carrito").textContent = "0.00";
    return;
  }
  vacio.style.display = "none";
  btnCobrar.disabled = false;

  carritoEsc.forEach((item, idx) => {
    const subtotal = item.precio * item.cantidad;
    total += subtotal;
    const div = document.createElement("div");
    div.className = "esc-carrito-item";
    div.innerHTML = `
      <div class="esc-carrito-nombre">${item.nombre}</div>
      <div class="esc-carrito-meta">
        $${Number(item.precio).toFixed(2)}${sufijoPrecioEsc(item.unidad_venta)} × ${formatearCantidadEsc(item.cantidad, item.unidad_venta)}
      </div>
      <div class="esc-carrito-sub">$${subtotal.toFixed(2)}</div>
      <div class="esc-carrito-acciones">
        <button type="button" data-editar="${idx}">✎ Cantidad</button>
        <button type="button" class="danger" data-quitar="${idx}">✕ Quitar</button>
      </div>
    `;
    lista.appendChild(div);
  });

  lista.querySelectorAll("[data-editar]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.editar, 10);
      const item = carritoEsc[idx];
      elegirProductoParaTicket(
        {
          codigo_barras: item.codigo_barras,
          nombre: item.nombre,
          precio_venta: item.precio,
          stock: item.stock,
          unidad_venta: item.unidad_venta,
          activo: true,
        },
        idx
      );
    });
  });
  lista.querySelectorAll("[data-quitar]").forEach((btn) => {
    btn.addEventListener("click", () => {
      carritoEsc.splice(parseInt(btn.dataset.quitar, 10), 1);
      renderCarritoEsc();
    });
  });

  document.getElementById("esc-total-carrito").textContent = total.toFixed(2);
}

document.getElementById("esc-btn-vaciar-carrito").addEventListener("click", () => {
  if (carritoEsc.length === 0) return;
  carritoEsc = [];
  renderCarritoEsc();
  toast("Carrito vacío");
});

// ---- Cobro rápido (mismos billetes MXN que en la PC) ----
const DENOMINACIONES_MXN = [20, 50, 100, 200, 500];

function _calcularOpcionesCobro(total) {
  let opciones = DENOMINACIONES_MXN.filter((billete) => billete >= total);
  if (opciones.length === 0) {
    const candidatos = new Set([
      Math.ceil(total / 500) * 500,
      Math.ceil(total / 1000) * 1000,
      Math.ceil(total / 500) * 500 + 500,
    ]);
    opciones = [...candidatos].filter((v) => v >= total).sort((a, b) => a - b);
  }
  return opciones.slice(0, 3);
}

function _mostrarResultadoCobroEsc(total, recibido) {
  const resultado = document.getElementById("esc-cobro-resultado");
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

function _crearChipCobroEsc(monto, total, textoSecundario) {
  const inputRecibido = document.getElementById("esc-input-recibido");
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = "chip-billete";
  chip.innerHTML = `<span class="chip-billete-monto">$${monto % 1 === 0 ? monto : monto.toFixed(2)}</span><span class="chip-billete-cambio">${textoSecundario}</span>`;
  chip.addEventListener("click", () => {
    inputRecibido.value = monto;
    document.querySelectorAll("#esc-billetes-sugeridos .chip-billete").forEach((c) => c.classList.remove("activo"));
    chip.classList.add("activo");
    _mostrarResultadoCobroEsc(total, monto);
  });
  return chip;
}

function _prepararCobroRapidoEsc(total) {
  const contenedor = document.getElementById("esc-billetes-sugeridos");
  const inputRecibido = document.getElementById("esc-input-recibido");
  contenedor.innerHTML = "";
  inputRecibido.value = "";
  _mostrarResultadoCobroEsc(total, null);

  const opciones = _calcularOpcionesCobro(total);
  const yaHayExacto = opciones.some((billete) => Math.abs(billete - total) < 0.005);
  if (!yaHayExacto) {
    contenedor.appendChild(_crearChipCobroEsc(total, total, "Pago exacto"));
  }
  opciones.forEach((billete) => {
    const cambio = billete - total;
    contenedor.appendChild(
      _crearChipCobroEsc(billete, total, cambio > 0 ? `Cambio $${cambio.toFixed(2)}` : "Pago exacto")
    );
  });
}

function abrirModalCobrarEsc() {
  if (carritoEsc.length === 0) {
    toast("El carrito está vacío", true);
    return;
  }
  const total = carritoEsc.reduce((acc, i) => acc + i.precio * i.cantidad, 0);
  const numArticulos = carritoEsc.reduce((acc, i) => acc + i.cantidad, 0);
  const metodoSel = document.getElementById("esc-metodo-pago");
  const metodo = metodoSel.selectedOptions[0].textContent;
  const esEfectivo = metodoSel.value === "efectivo";

  document.getElementById("esc-modal-venta-resumen").textContent =
    `${formatearCantidadEsc(numArticulos, "pieza")} artículo(s) · Pago: ${metodo}`;
  document.getElementById("esc-modal-venta-total").textContent = total.toFixed(2);

  document.getElementById("esc-cobro-rapido").style.display = esEfectivo ? "block" : "none";
  if (esEfectivo) _prepararCobroRapidoEsc(total);

  document.getElementById("esc-modal-cobrar").style.display = "flex";
}

function cerrarModalCobrarEsc() {
  document.getElementById("esc-modal-cobrar").style.display = "none";
}

document.getElementById("esc-btn-cobrar").addEventListener("click", abrirModalCobrarEsc);
document.getElementById("esc-btn-cancelar-cobro").addEventListener("click", cerrarModalCobrarEsc);

document.getElementById("esc-input-recibido").addEventListener("input", (e) => {
  document.querySelectorAll("#esc-billetes-sugeridos .chip-billete").forEach((c) => c.classList.remove("activo"));
  const total = parseFloat(document.getElementById("esc-modal-venta-total").textContent) || 0;
  const recibido = parseFloat(e.target.value);
  _mostrarResultadoCobroEsc(total, e.target.value.trim() === "" ? null : recibido);
});

document.getElementById("esc-btn-confirmar-cobro").addEventListener("click", async () => {
  const btn = document.getElementById("esc-btn-confirmar-cobro");
  btn.disabled = true;
  try {
    const venta = await api("/ventas", {
      method: "POST",
      body: JSON.stringify({
        items: carritoEsc.map((i) => ({ codigo_barras: i.codigo_barras, cantidad: i.cantidad })),
        metodo_pago: document.getElementById("esc-metodo-pago").value,
      }),
    });

    const esEfectivo = document.getElementById("esc-metodo-pago").value === "efectivo";
    const recibido = parseFloat(document.getElementById("esc-input-recibido").value);
    let mensaje = `Venta #${venta.id} — Total $${Number(venta.total).toFixed(2)}`;
    if (esEfectivo && !isNaN(recibido) && recibido >= venta.total) {
      mensaje += ` — Cambio: $${(recibido - venta.total).toFixed(2)}`;
    }
    toast(mensaje);

    carritoEsc = [];
    renderCarritoEsc();
    cerrarModalCobrarEsc();
    cargarCatalogoEsc(); // refresca stock
  } catch (e) {
    toast(e.message, true);
    cerrarModalCobrarEsc();
  } finally {
    btn.disabled = false;
  }
});

// Arranque
cargarSesionGuardada();
