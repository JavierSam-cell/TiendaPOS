const API = "/api";
// Mismas llaves de localStorage que usa app.js: si en este mismo celular
// alguna vez abres el sistema completo con esta cuenta, la sesión ya
// queda compartida (y viceversa), sin tener que loguearte dos veces.
let sesion = { token: null, usuario: null };

// Permisos granulares del usuario (igual que en app.js): un cajero puede
// tener permiso de "productos.agregar" aunque no sea admin, así que el
// alta rápida desde el escaneo se habilita según este permiso, no según
// el rol.
let permisosEfectivos = {};

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

// ---------------------------------------------------------
// Toast + bip (igual que en el sistema principal)
// ---------------------------------------------------------
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
  } catch (e) { /* si el navegador bloquea audio, no pasa nada grave */ }
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
    mostrarPantallaLogin();
  }
}

function cerrarSesionLocal() {
  localStorage.removeItem("pos_token");
  localStorage.removeItem("pos_usuario");
  sesion = { token: null, usuario: null };
  detenerEscaneoSiActivo();
  mostrarPantallaLogin();
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
// ESCÁNER (misma técnica de recorte + zoom que en app.js: solo se
// analiza el recuadro guía, no la foto completa, para leer rápido y sin
// errores).
// ---------------------------------------------------------
const FORMATOS_CODIGO_BARRAS = [
  "ean_13", "ean_8", "upc_a", "upc_e",
  "code_128", "code_39", "code_93", "codabar", "itf", "qr_code",
];
// Debe coincidir con #esc-video-wrap::after en el <style> de escanear.html.
const RECUADRO_GUIA_ANCHO = 0.78;
const RECUADRO_GUIA_ALTO = 0.30;

let _stream = null;
let _detenido = true;

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

function distanciaAlCentro(codigo, cx, cy) {
  const caja = codigo.boundingBox;
  if (!caja) return 0;
  const codX = caja.x + caja.width / 2;
  const codY = caja.y + caja.height / 2;
  return (codX - cx) ** 2 + (codY - cy) ** 2;
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
  document.getElementById("btn-esc-scan-txt").textContent = "Escanear código de barras";
}

function iniciarEscaneo() {
  const wrap = document.getElementById("esc-video-wrap");
  const contenedor = document.getElementById("esc-video-contenedor");
  contenedor.innerHTML = "";
  wrap.classList.add("mostrar");

  const btn = document.getElementById("btn-esc-scan");
  btn.classList.add("escaneando");
  document.getElementById("btn-esc-scan-txt").textContent = "Cancelar";

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

      const detectarCuadro = () => {
        if (_detenido) return;
        if (!video.videoWidth) {
          requestAnimationFrame(detectarCuadro);
          return;
        }

        const anchoRecorte = video.videoWidth * RECUADRO_GUIA_ANCHO;
        const altoRecorte = video.videoHeight * RECUADRO_GUIA_ALTO;
        const xRecorte = (video.videoWidth - anchoRecorte) / 2;
        const yRecorte = (video.videoHeight - altoRecorte) / 2;
        const escala = Math.min(3, Math.max(1, 900 / anchoRecorte));
        canvasRecorte.width = Math.round(anchoRecorte * escala);
        canvasRecorte.height = Math.round(altoRecorte * escala);
        ctxRecorte.imageSmoothingEnabled = escala <= 1;
        ctxRecorte.drawImage(
          video,
          xRecorte, yRecorte, anchoRecorte, altoRecorte,
          0, 0, canvasRecorte.width, canvasRecorte.height
        );

        detector
          .detect(canvasRecorte)
          .then((codigos) => {
            if (_detenido) return;
            const validos = codigos.filter((c) => checksumEanUpcValido(c.rawValue));
            if (validos.length === 0) {
              vecesSeguidas = 0;
              requestAnimationFrame(detectarCuadro);
              return;
            }
            const cx = canvasRecorte.width / 2;
            const cy = canvasRecorte.height / 2;
            validos.sort((a, b) => distanciaAlCentro(a, cx, cy) - distanciaAlCentro(b, cx, cy));
            const elegido = validos[0];

            if (elegido.rawValue === ultimoCandidato) {
              vecesSeguidas++;
            } else {
              ultimoCandidato = elegido.rawValue;
              vecesSeguidas = 1;
            }

            if (vecesSeguidas >= 2) {
              enviarCodigoEscaneado(elegido.rawValue);
              detenerEscaneoSiActivo();
              return;
            }
            requestAnimationFrame(detectarCuadro);
          })
          .catch(() => {
            if (!_detenido) requestAnimationFrame(detectarCuadro);
          });
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

// ---------------------------------------------------------
// Enviar el código a la computadora + entrada manual de respaldo
// ---------------------------------------------------------
async function enviarCodigoEscaneado(codigo) {
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
    // Además de mandarlo a la compu, se revisa aquí mismo si el producto
    // existe: si no, se ofrece darlo de alta desde el celular (igual que
    // en la pantalla de Vender), en vez de dejar al usuario sin saber
    // qué pasó con el código que acaba de escanear.
    revisarCodigoLocal(codigo);
  } catch (err) {
    toast(err.message || "No se pudo enviar el código", true);
  }
}

// ---------------------------------------------------------
// Si el código no está en el catálogo, se busca en internet y se
// ofrece darlo de alta directo desde el celular (mismo flujo que la
// pantalla de Vender en la computadora).
// ---------------------------------------------------------
async function revisarCodigoLocal(codigo) {
  ocultarNoEncontrado();
  try {
    await api(`/productos/codigo/${encodeURIComponent(codigo)}`);
    // El producto ya existe: no hace falta nada más, ya se mandó a la compu.
  } catch (err) {
    if (err.message.includes("no encontrado") || err.message.includes("Producto no")) {
      mostrarNoEncontrado(codigo);
    }
    // Otros errores (de red, etc.) se ignoran aquí para no interrumpir el escaneo.
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
    // Se vuelve a mandar el código: ahora sí existe, así que si en la
    // compu están parados en Vender lo agrega solo al carrito.
    enviarCodigoEscaneado(codigo);
  } catch (err) {
    toast(err.message || "No se pudo dar de alta el producto", true);
  }
});

// ---------------------------------------------------------
// Buscador por nombre o código (para cuando la cámara no lee el
// código): mismo criterio que el buscador de la pantalla Vender.
// Se trae el catálogo una vez (al entrar a la pantalla de escaneo)
// y se filtra localmente mientras el cajero escribe.
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
    const precioTexto = p.unidad_venta === "kg" ? `$${p.precio_venta.toFixed(2)}/kg` : `$${p.precio_venta.toFixed(2)}`;
    btn.innerHTML = `
      <span>
        <span class="esc-resultado-nombre">${p.nombre}</span><br>
        <span class="esc-resultado-codigo">${p.requiere_codigo === false ? "sin código" : p.codigo_barras}</span>
      </span>
      <span class="esc-resultado-precio">${precioTexto}</span>
    `;
    btn.addEventListener("click", () => {
      enviarCodigoEscaneado(p.codigo_barras);
      document.getElementById("esc-buscar-input").value = "";
      renderResultadosBusquedaEsc([]);
      document.getElementById("esc-buscar-vacio").style.display = "none";
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

  // 1) Coincidencia exacta de código de barras
  const porCodigo = _catalogoEsc.find(
    (p) => (p.codigo_barras || "").toLowerCase() === crudo.toLowerCase()
  );
  if (porCodigo) {
    input.value = "";
    filtrarBusquedaEsc("");
    enviarCodigoEscaneado(porCodigo.codigo_barras);
    return;
  }

  // 2) Parece código de barras aunque no esté en el catálogo: se manda
  // igual, tal cual se haría si el lector lo hubiera leído (dispara el
  // flujo de "no encontrado" si de verdad no existe).
  if (_pareceCodigoBarrasEsc(crudo)) {
    input.value = "";
    filtrarBusquedaEsc("");
    enviarCodigoEscaneado(crudo);
    return;
  }

  // 3) Un solo resultado por nombre → se manda directo
  const resultados = _resultadosBusquedaEsc(crudo);
  if (resultados.length === 1) {
    input.value = "";
    filtrarBusquedaEsc("");
    enviarCodigoEscaneado(resultados[0].codigo_barras);
    return;
  }

  // 4) Varios o ninguno: se deja la lista filtrada visible
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

// Arranque
cargarSesionGuardada();
