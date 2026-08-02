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

function activarMayusculasEnFormularios(root = document) {
  const EXCLUIR = new Set(["password","email","number","tel","url","date","time","datetime-local","month","week","hidden","checkbox","radio","file","range","color","search"]);
  const forzar = (el) => {
    if (!el || (el.tagName !== "INPUT" && el.tagName !== "TEXTAREA")) return;
    if (el.dataset && el.dataset.noUppercase !== undefined) return;
    const tipo = (el.type || "text").toLowerCase();
    if (EXCLUIR.has(tipo)) return;
    const inicio = el.selectionStart, fin = el.selectionEnd;
    const upper = String(el.value || "").toLocaleUpperCase("es-MX");
    if (el.value !== upper) {
      el.value = upper;
      try { if (inicio != null && fin != null && el.setSelectionRange) el.setSelectionRange(inicio, fin); } catch (_) {}
    }
  };
  root.addEventListener("input", (e) => forzar(e.target), true);
  root.addEventListener("blur", (e) => forzar(e.target), true);
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
  } catch (err) {
    toast(err.message || "No se pudo enviar el código", true);
  }
}


activarMayusculasEnFormularios();
cargarSesionGuardada();
