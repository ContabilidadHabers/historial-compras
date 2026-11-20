// =====================================================================
//  HISTORIAL DE COMPRAS · HABERS  (versión 2)
//  - Lee XML de facturas (CFDI 3.3 y 4.0) y los guarda en Firebase
//  - Captura manual para gastos sin XML
//  - Tabla estilo Excel con buscador, filtro por proveedor,
//    edición (✏️) y borrado (🗑) de filas
// =====================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, addDoc, getDocs, getDoc, setDoc, deleteDoc, updateDoc,
  doc, query, where, onSnapshot, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// #####################################################################
// ##  ⬇⬇⬇  PEGA AQUÍ TU firebaseConfig (el mismo que ya tenías)  ⬇⬇⬇  ##
// ##  Copia el bloque desde tu app.js anterior en GitHub y          ##
// ##  reemplaza este bloque completo, de "const" hasta "};"         ##
// #####################################################################
const firebaseConfig = {
  apiKey: "AIzaSyBhbyRsVRr1pGpmN0dbhM-Nk9vU9eu7yxE",
  authDomain: "historial-compras-8e988.firebaseapp.com",
  projectId: "historial-compras-8e988",
  storageBucket: "historial-compras-8e988.firebasestorage.app",
  messagingSenderId: "661408212470",
  appId: "1:661408212470:web:2b9cbc730a95f9079993d7",
  measurementId: "G-4KE1BRVQFP"
};
// #####################################################################
// ##  ⬆⬆⬆  FIN DEL BLOQUE A REEMPLAZAR  ⬆⬆⬆                          ##
// #####################################################################

const app  = initializeApp(firebaseConfig);
const db   = getFirestore(app);
const auth = getAuth(app);

// Nombres de las dos "carpetas" (colecciones) en Firebase
const PESTANAS = {
  adquisiciones:  "ADQUISICIONES",
  compras_centro: "COMPRAS DEL CENTRO"
};

const MESES = ["Enero","Febrero","Marzo","Abril","Mayo","Junio","Julio",
               "Agosto","Septiembre","Octubre","Noviembre","Diciembre"];

// Unidades más comunes del SAT, por si el XML no trae el nombre de la unidad
const UNIDADES_SAT = {
  H87: "PIEZA", E48: "SERVICIO", MTR: "METROS", KGM: "KILOGRAMO",
  ACT: "ACTIVIDAD", XBX: "CAJA", LTR: "LITRO", C62: "UNIDAD",
  E51: "TRABAJO", MTK: "METRO CUADRADO", SET: "JUEGO", PR: "PAR",
  XUN: "UNIDAD", XPK: "PAQUETE", KT: "KIT", GRM: "GRAMO", XRO: "ROLLO",
  A9: "TARIFA", E54: "VIAJE", DAY: "DÍA", HUR: "HORA", MON: "MES"
};

// Estado de la pantalla
let coleccionActual = "adquisiciones";
let registros = [];                  // lo que hay en Firebase para la pestaña actual
let dejarDeEscuchar = null;          // para cambiar de pestaña sin mezclar datos
let filtroProveedores = new Set();   // proveedores elegidos en el filtro (vacío = todos)
let seleccionTemporal = new Set();   // lo que se va marcando dentro del panel
let idEditando = null;               // fila que se está editando

// Atajos a los elementos de la página
const $ = (id) => document.getElementById(id);
const dropzone = $("dropzone");
const selector = $("selectorArchivos");
const buscador = $("buscador");
const cuerpo   = $("cuerpoTabla");

// Formatos de dinero y número
const dinero = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const numero = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 3 });

// =====================================================================
//  UTILIDADES
// =====================================================================
function limpiar(t) {
  // Minúsculas, sin acentos y sin espacios dobles: "COMPAÑÍA  Real" → "compania real"
  return String(t ?? "").toLowerCase().normalize("NFD")
    .replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}
function escapar(t) {
  return String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function fechaBonita(f) {
  return f && f.length === 10 ? `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}` : (f || "");
}
function mesDeFecha(f) {
  return f && f.length >= 7 ? MESES[Number(f.slice(5, 7)) - 1] || "" : "";
}
function redondear(n) {
  return Math.round(n * 100) / 100;
}
function numOVacio(v) {
  // Convierte el texto de un campo a número; si está vacío regresa null
  return v === "" || v == null ? null : Number(v);
}
function aviso(tipo, texto) {
  const div = document.createElement("div");
  div.className = `msg ${tipo}`;
  div.textContent = texto;
  $("mensajes").appendChild(div);
}

// =====================================================================
//  ACCESO (login)
// =====================================================================
$("btnEntrar").addEventListener("click", entrar);
$("clave").addEventListener("keydown", (e) => { if (e.key === "Enter") entrar(); });
$("btnSalir").addEventListener("click", () => signOut(auth));

async function entrar() {
  $("errorLogin").textContent = "";
  try {
    await signInWithEmailAndPassword(auth, $("correo").value.trim(), $("clave").value);
  } catch (e) {
    $("errorLogin").textContent = "Correo o contraseña incorrectos.";
  }
}

onAuthStateChanged(auth, (usuario) => {
  if (usuario) {
    $("login").classList.add("oculto");
    $("app").classList.remove("oculto");
    abrirPestana(coleccionActual);
  } else {
    $("app").classList.add("oculto");
    $("login").classList.remove("oculto");
    if (dejarDeEscuchar) dejarDeEscuchar();
  }
});

// =====================================================================
//  PESTAÑAS
// =====================================================================
document.querySelectorAll(".pestana").forEach((boton) => {
  boton.addEventListener("click", () => {
    document.querySelectorAll(".pestana").forEach(b => b.classList.remove("activa"));
    boton.classList.add("activa");
    abrirPestana(boton.dataset.coleccion);
  });
});

function abrirPestana(nombre) {
  coleccionActual = nombre;
  filtroProveedores = new Set();       // cada pestaña empieza sin filtro
  cerrarPanelProveedores();
  $("destino").textContent = `Se guardarán en: ${PESTANAS[nombre]}`;
  $("destinoManual").textContent = `→ ${PESTANAS[nombre]}`;
  $("mensajes").innerHTML = "";
  cuerpo.innerHTML = `<tr><td colspan="10">Cargando...</td></tr>`;
  if (dejarDeEscuchar) dejarDeEscuchar();

  // Escucha en tiempo real: si alguien más sube o edita algo, se actualiza solo
  dejarDeEscuchar = onSnapshot(collection(db, nombre), (snap) => {
    registros = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    registros.sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));  // más recientes primero
    actualizarSugerenciasProveedores();
    pintarTabla();
  }, (error) => {
    aviso("error", "No se pudo leer Firebase: " + error.message);
  });
}

// =====================================================================
//  CAPTURA MANUAL (recuadro izquierdo)
// =====================================================================
const formManual = $("formManual");

// Muestra el importe mientras escribes cantidad y precio
formManual.addEventListener("input", () => {
  const c = Number(formManual.cantidad.value) || 0;
  const p = Number(formManual.precioUnitario.value) || 0;
  $("importeManual").textContent = dinero.format(redondear(c * p));
});

formManual.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = formManual;
  const cantidad = Number(f.cantidad.value);
  const precio   = Number(f.precioUnitario.value);
  const registro = {
    mes: mesDeFecha(f.fecha.value),
    fecha: f.fecha.value,
    folio: f.folio.value.trim() || "(sin CFDI)",
    uuid: "",
    proveedor: f.proveedor.value.trim().toUpperCase(),
    rfcEmisor: "",
    descripcion: f.descripcion.value.trim(),
    cantidad,
    unidad: f.unidad.value.trim().toUpperCase() || "PIEZA",
    precioUnitario: precio,
    importe: redondear(cantidad * precio),
    origen: "manual",
    creado: serverTimestamp()
  };
  try {
    await addDoc(collection(db, coleccionActual), registro);
    $("mensajes").innerHTML = "";
    aviso("ok", `✔ Registro guardado: ${registro.proveedor} · ${registro.descripcion} · ${dinero.format(registro.importe)} en ${PESTANAS[coleccionActual]}.`);
    // Limpia el formulario pero conserva la fecha y el proveedor (útil si capturas varias líneas seguidas)
    const fecha = f.fecha.value, proveedor = f.proveedor.value, folio = f.folio.value;
    f.reset();
    f.fecha.value = fecha; f.proveedor.value = proveedor; f.folio.value = folio;
    $("importeManual").textContent = dinero.format(0);
    f.descripcion.focus();
  } catch (err) {
    aviso("error", "No se pudo guardar: " + err.message);
  }
});

function actualizarSugerenciasProveedores() {
  const nombres = [...new Set(registros.map(r => r.proveedor).filter(Boolean))].sort();
  $("listaNombresProveedores").innerHTML = nombres.map(n => `<option value="${escapar(n)}">`).join("");
}

// =====================================================================
//  ZONA PARA ARRASTRAR Y SOLTAR XML (recuadro derecho)
// =====================================================================
dropzone.addEventListener("click", () => selector.click());
selector.addEventListener("change", () => { procesarArchivos(selector.files); selector.value = ""; });

["dragenter", "dragover"].forEach(ev =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("encima"); }));
["dragleave", "drop"].forEach(ev =>
  dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("encima"); }));
dropzone.addEventListener("drop", (e) => procesarArchivos(e.dataTransfer.files));

async function procesarArchivos(archivos) {
  $("mensajes").innerHTML = "";
  for (const archivo of archivos) {
    if (!archivo.name.toLowerCase().endsWith(".xml")) {
      aviso("aviso", `${archivo.name}: no es un XML, se omitió.`);
      continue;
    }
    try {
      const texto = await archivo.text();
      const factura = leerCFDI(texto);
      await guardarFactura(factura, archivo.name);
    } catch (e) {
      aviso("error", `${archivo.name}: ${e.message}`);
    }
  }
}

// =====================================================================
//  LECTURA DEL CFDI (funciona con versión 3.3 y 4.0)
// =====================================================================
function leerCFDI(textoXML) {
  const xml = new DOMParser().parseFromString(textoXML, "application/xml");
  if (xml.getElementsByTagName("parsererror").length) {
    throw new Error("el archivo XML está dañado o no se puede leer.");
  }
  // Busca etiquetas sin importar el prefijo (cfdi:, tfd:, etc.)
  const buscar = (padre, nombre) => padre.getElementsByTagNameNS("*", nombre);

  const comprobante = buscar(xml, "Comprobante")[0];
  if (!comprobante) throw new Error("no parece ser una factura CFDI.");

  const tipo = comprobante.getAttribute("TipoDeComprobante") || "I";
  if (tipo === "P") throw new Error("es un complemento de pago (no trae productos), se omitió.");

  const emisor = buscar(comprobante, "Emisor")[0];
  const timbre = buscar(xml, "TimbreFiscalDigital")[0];
  const uuid   = timbre ? (timbre.getAttribute("UUID") || "").toUpperCase() : "";
  const serie  = comprobante.getAttribute("Serie") || "";
  const folio  = comprobante.getAttribute("Folio") || "";
  const fecha  = (comprobante.getAttribute("Fecha") || "").slice(0, 10); // AAAA-MM-DD

  const conceptos = [...buscar(comprobante, "Concepto")].map((c) => {
    const clave = c.getAttribute("ClaveUnidad") || "";
    const importe = Number(c.getAttribute("Importe") || 0) - Number(c.getAttribute("Descuento") || 0);
    let descripcion = c.getAttribute("Descripcion") || "";
    if (tipo === "E") descripcion = "[NOTA DE CRÉDITO] " + descripcion;
    return {
      descripcion,
      cantidad: Number(c.getAttribute("Cantidad") || 0),
      unidad: (c.getAttribute("Unidad") || UNIDADES_SAT[clave] || clave).toUpperCase(),
      precioUnitario: Number(c.getAttribute("ValorUnitario") || 0),
      importe: redondear(importe)
    };
  });

  if (!conceptos.length) throw new Error("la factura no trae conceptos.");

  return {
    fecha,
    mes: mesDeFecha(fecha),
    folio: (serie && folio) ? `${serie}-${folio}` : (folio || uuid),
    uuid,
    proveedor: emisor ? (emisor.getAttribute("Nombre") || "").trim() : "",
    rfcEmisor: emisor ? (emisor.getAttribute("Rfc") || "") : "",
    conceptos
  };
}

// =====================================================================
//  GUARDAR FACTURA XML EN FIREBASE (una fila por cada producto)
// =====================================================================
async function guardarFactura(f, nombreArchivo) {
  // Evita subir la misma factura dos veces en la misma pestaña
  if (f.uuid) {
    const repetida = await getDocs(query(collection(db, coleccionActual), where("uuid", "==", f.uuid)));
    if (!repetida.empty) {
      aviso("aviso", `${nombreArchivo}: esta factura (${f.folio}) ya estaba cargada, no se duplicó.`);
      return;
    }
  }

  const lote = writeBatch(db);
  f.conceptos.forEach((c) => {
    const ref = doc(collection(db, coleccionActual));
    lote.set(ref, {
      mes: f.mes, fecha: f.fecha, folio: f.folio, uuid: f.uuid,
      proveedor: f.proveedor, rfcEmisor: f.rfcEmisor,
      descripcion: c.descripcion, cantidad: c.cantidad, unidad: c.unidad,
      precioUnitario: c.precioUnitario, importe: c.importe,
      origen: "xml", archivo: nombreArchivo, creado: serverTimestamp()
    });
  });
  await lote.commit();
  aviso("ok", `✔ ${f.proveedor} · ${f.folio}: ${f.conceptos.length} producto(s) guardado(s) en ${PESTANAS[coleccionActual]}.`);
}

// =====================================================================
//  TABLA + BUSCADOR + FILTRO DE PROVEEDOR
// =====================================================================
buscador.addEventListener("input", pintarTabla);

function filasVisibles() {
  // Buscador: frase EXACTA (sin importar mayúsculas ni acentos),
  // solo en Proveedor, Descripción y Número de factura. Ignora fechas y montos.
  const frase = limpiar(buscador.value);
  return registros.filter((r) => {
    if (filtroProveedores.size && !filtroProveedores.has(r.proveedor || "")) return false;
    if (!frase) return true;
    return limpiar(r.proveedor).includes(frase)
        || limpiar(r.descripcion).includes(frase)
        || limpiar(r.folio).includes(frase);
  });
}

function pintarTabla() {
  const visibles = filasVisibles();
  let total = 0;

  cuerpo.innerHTML = visibles.map((r) => {
    total += Number(r.importe) || 0;
    return `<tr>
      <td class="nowrap">${escapar(r.mes)}</td>
      <td class="nowrap">${escapar(fechaBonita(r.fecha))}</td>
      <td class="nowrap" title="${escapar(r.uuid)}">${escapar(r.folio)}</td>
      <td>${escapar(r.proveedor)}</td>
      <td>${escapar(r.descripcion)}</td>
      <td class="num">${r.cantidad == null ? "" : numero.format(r.cantidad)}</td>
      <td class="nowrap">${escapar(r.unidad)}</td>
      <td class="num precio">${r.precioUnitario == null ? "" : dinero.format(r.precioUnitario)}</td>
      <td class="num">${r.importe == null ? "" : dinero.format(r.importe)}</td>
      <td class="acciones">
        <button class="accion editar" data-id="${r.id}" title="Editar esta fila">✏️</button>
        <button class="accion borrar" data-id="${r.id}" title="Borrar esta fila">🗑</button>
      </td>
    </tr>`;
  }).join("") || `<tr><td colspan="10" style="text-align:center;padding:20px">Sin registros</td></tr>`;

  $("totalImporte").textContent = dinero.format(total);
  $("contador").textContent = `Mostrando ${visibles.length} de ${registros.length} registros`;

  // Aviso amarillo cuando hay filtro de proveedor activo
  const etiqueta = $("avisoFiltro");
  if (filtroProveedores.size) {
    const nombres = [...filtroProveedores];
    const texto = nombres.length === 1 ? nombres[0] : `${nombres.length} proveedores`;
    etiqueta.innerHTML = `Filtro: <b>${escapar(texto)}</b> <button title="Quitar filtro" id="quitarFiltroRapido">✕</button>`;
    etiqueta.classList.remove("oculto");
    $("quitarFiltroRapido").onclick = () => { filtroProveedores = new Set(); pintarTabla(); };
    $("btnFiltroProv").classList.add("activo");
  } else {
    etiqueta.classList.add("oculto");
    $("btnFiltroProv").classList.remove("activo");
  }
}

// Clics en ✏️ y 🗑 de cada fila
cuerpo.addEventListener("click", async (e) => {
  const boton = e.target.closest(".accion");
  if (!boton) return;
  const id = boton.dataset.id;
  if (boton.classList.contains("editar")) {
    abrirEdicion(id);
  } else if (boton.classList.contains("borrar")) {
    if (!confirm("¿Borrar esta fila? No se puede deshacer.")) return;
    await deleteDoc(doc(db, coleccionActual, id));
  }
});

// ---------------------------------------------------------------------
//  Panel del filtro de proveedores (el ▼ del encabezado)
// ---------------------------------------------------------------------
const panel = $("panelProveedores");

$("btnFiltroProv").addEventListener("click", (e) => {
  e.stopPropagation();
  if (!panel.classList.contains("oculto")) return cerrarPanelProveedores();
  seleccionTemporal = new Set(filtroProveedores);
  $("buscaProveedor").value = "";
  pintarListaProveedores();
  // Coloca el panel justo debajo del botón
  const caja = e.currentTarget.getBoundingClientRect();
  panel.style.top  = `${caja.bottom + 6}px`;
  panel.style.left = `${Math.max(8, Math.min(caja.left - 160, window.innerWidth - 370))}px`;
  panel.classList.remove("oculto");
  $("buscaProveedor").focus();
});

$("buscaProveedor").addEventListener("input", pintarListaProveedores);

function pintarListaProveedores() {
  // Lista única de proveedores de esta pestaña, con su total comprado
  const totales = new Map();
  registros.forEach((r) => {
    const n = r.proveedor || "";
    totales.set(n, (totales.get(n) || 0) + (Number(r.importe) || 0));
  });
  const busca = limpiar($("buscaProveedor").value);
  const nombres = [...totales.keys()].sort().filter(n => limpiar(n).includes(busca));
  const todosMarcados = nombres.length > 0 && nombres.every(n => seleccionTemporal.has(n));

  $("listaProveedores").innerHTML =
    `<label class="todos"><input type="checkbox" id="marcarTodos" ${todosMarcados ? "checked" : ""}>
       <span class="nombre">(Seleccionar todos los mostrados)</span></label>` +
    nombres.map((n, i) => `
      <label>
        <input type="checkbox" data-i="${i}" ${seleccionTemporal.has(n) ? "checked" : ""}>
        <span class="nombre">${escapar(n || "(sin proveedor)")}</span>
        <span class="monto">${dinero.format(totales.get(n))}</span>
      </label>`).join("");

  $("listaProveedores").querySelectorAll("input[data-i]").forEach((caja) => {
    caja.addEventListener("change", () => {
      const n = nombres[caja.dataset.i];
      caja.checked ? seleccionTemporal.add(n) : seleccionTemporal.delete(n);
      $("marcarTodos").checked = nombres.every(x => seleccionTemporal.has(x));
    });
  });
  $("marcarTodos").addEventListener("change", (e) => {
    nombres.forEach(n => e.target.checked ? seleccionTemporal.add(n) : seleccionTemporal.delete(n));
    pintarListaProveedores();
  });
}

$("btnAplicarProv").addEventListener("click", () => {
  filtroProveedores = new Set(seleccionTemporal);
  cerrarPanelProveedores();
  pintarTabla();
});
$("btnLimpiarProv").addEventListener("click", () => {
  filtroProveedores = new Set();
  cerrarPanelProveedores();
  pintarTabla();
});

function cerrarPanelProveedores() { panel.classList.add("oculto"); }

// Cierra el panel si das clic fuera de él
document.addEventListener("click", (e) => {
  if (!panel.classList.contains("oculto") && !e.composedPath().includes(panel)) cerrarPanelProveedores();
});

// =====================================================================
//  EDITAR UNA FILA (✏️)
// =====================================================================
const formEdicion = $("formEdicion");
let cantidadOriginal = null, precioOriginal = null;

function abrirEdicion(id) {
  const r = registros.find(x => x.id === id);
  if (!r) return;
  idEditando = id;
  const f = formEdicion;
  f.mes.value            = r.mes || mesDeFecha(r.fecha) || "Enero";
  f.fecha.value          = r.fecha || "";
  f.folio.value          = r.folio || "";
  f.proveedor.value      = r.proveedor || "";
  f.descripcion.value    = r.descripcion || "";
  f.cantidad.value       = r.cantidad ?? "";
  f.unidad.value         = r.unidad || "";
  f.precioUnitario.value = r.precioUnitario ?? "";
  f.importe.value        = r.importe ?? "";
  cantidadOriginal = f.cantidad.value;
  precioOriginal   = f.precioUnitario.value;
  const origen = { xml: "cargado desde XML", manual: "captura manual", excel: "historial de Excel" }[r.origen] || "";
  $("subEdicion").textContent = `${PESTANAS[coleccionActual]} · ${origen}${r.uuid ? " · UUID " + r.uuid : ""}`;
  $("fondoEdicion").classList.remove("oculto");
}

// Si cambias la fecha, el mes se ajusta solo (puedes cambiarlo a mano después)
formEdicion.fecha.addEventListener("change", () => {
  const m = mesDeFecha(formEdicion.fecha.value);
  if (m) formEdicion.mes.value = m;
});

// Si cambias cantidad o precio, el importe se recalcula
["cantidad", "precioUnitario"].forEach((campo) => {
  formEdicion[campo].addEventListener("input", () => {
    const f = formEdicion;
    if (f.cantidad.value === cantidadOriginal && f.precioUnitario.value === precioOriginal) return;
    const c = Number(f.cantidad.value) || 0, p = Number(f.precioUnitario.value) || 0;
    f.importe.value = redondear(c * p);
  });
});

formEdicion.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = formEdicion;
  const cambios = {
    mes: f.mes.value,
    fecha: f.fecha.value,
    folio: f.folio.value.trim(),
    proveedor: f.proveedor.value.trim(),
    descripcion: f.descripcion.value.trim(),
    cantidad: numOVacio(f.cantidad.value),
    unidad: f.unidad.value.trim(),
    precioUnitario: numOVacio(f.precioUnitario.value),
    importe: numOVacio(f.importe.value),
    editado: serverTimestamp()
  };
  try {
    await updateDoc(doc(db, coleccionActual, idEditando), cambios);
    cerrarEdicion();
    $("mensajes").innerHTML = "";
    aviso("ok", `✔ Cambios guardados: ${cambios.proveedor} · ${cambios.descripcion}.`);
  } catch (err) {
    alert("No se pudo guardar: " + err.message);
  }
});

$("btnCancelarEdicion").addEventListener("click", cerrarEdicion);
$("fondoEdicion").addEventListener("click", (e) => { if (e.target.id === "fondoEdicion") cerrarEdicion(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { cerrarEdicion(); cerrarPanelProveedores(); }
});

function cerrarEdicion() {
  $("fondoEdicion").classList.add("oculto");
  idEditando = null;
}

// =====================================================================
//  CARGA INICIAL DEL HISTORIAL DE EXCEL (se usó UNA sola vez)
//  Se conserva por si algún día la necesitas. No afecta en nada.
//  En la consola (F12):   cargarHistorialInicial("adquisiciones")
// =====================================================================
window.cargarHistorialInicial = async function (destino = "adquisiciones") {
  if (!PESTANAS[destino]) return console.error('Destino inválido. Usa "adquisiciones" o "compras_centro".');
  if (!auth.currentUser) return console.error("Primero inicia sesión en la página.");

  const marca = doc(db, "_control", "historial_" + destino);
  if ((await getDoc(marca)).exists()) {
    return console.warn("⚠ El historial ya se había cargado en " + PESTANAS[destino] + ". No se volvió a subir.");
  }

  const resp = await fetch("historial_inicial.json");
  if (!resp.ok) return console.error("No encontré el archivo historial_inicial.json junto a la página.");
  const datos = await resp.json();
  console.log(`Subiendo ${datos.length} registros a ${PESTANAS[destino]}...`);

  for (let i = 0; i < datos.length; i += 400) {          // Firebase acepta hasta 500 por envío
    const lote = writeBatch(db);
    datos.slice(i, i + 400).forEach((r) => {
      lote.set(doc(collection(db, destino)), { ...r, creado: serverTimestamp() });
    });
    await lote.commit();
    console.log(`  ✔ ${Math.min(i + 400, datos.length)} de ${datos.length}`);
  }
  await setDoc(marca, { cargado: serverTimestamp(), registros: datos.length });
  console.log("✅ Listo. Historial cargado.");
};
