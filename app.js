// =====================================================================
//  HISTORIAL DE COMPRAS · HABERS
//  Lee XML de facturas (CFDI 3.3 y 4.0), los guarda en Firebase y los
//  muestra en una tabla estilo Excel con buscador.
// =====================================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore, collection, getDocs, getDoc, setDoc, deleteDoc,
  doc, query, where, onSnapshot, writeBatch, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getAuth, signInWithEmailAndPassword, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

// ---------------------------------------------------------------------
// 1) PEGA AQUÍ TUS CREDENCIALES DE FIREBASE (Paso 1 de la guía)
//    Reemplaza TODO este bloque por el que te da Firebase.
// ---------------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyBhbyRsVRr1pGpmN0dbhM-Nk9vU9eu7yxE",
  authDomain: "historial-compras-8e988.firebaseapp.com",
  projectId: "historial-compras-8e988",
  storageBucket: "historial-compras-8e988.firebasestorage.app",
  messagingSenderId: "661408212470",
  appId: "1:661408212470:web:2b9cbc730a95f9079993d7",
  measurementId: "G-4KE1BRVQFP"
};
// ---------------------------------------------------------------------

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
let registros = [];          // lo que hay en Firebase para la pestaña actual
let dejarDeEscuchar = null;  // para cambiar de pestaña sin mezclar datos

// Atajos a los elementos de la página
const $ = (id) => document.getElementById(id);
const dropzone   = $("dropzone");
const selector   = $("selectorArchivos");
const buscador   = $("buscador");
const cuerpo     = $("cuerpoTabla");

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
  $("destino").textContent = `Se guardarán en: ${PESTANAS[nombre]}`;
  $("mensajes").innerHTML = "";
  cuerpo.innerHTML = `<tr><td colspan="10">Cargando...</td></tr>`;
  if (dejarDeEscuchar) dejarDeEscuchar();

  // Escucha en tiempo real: si alguien más sube una factura, aparece sola
  dejarDeEscuchar = onSnapshot(collection(db, nombre), (snap) => {
    registros = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    // Más recientes primero
    registros.sort((a, b) => (b.fecha || "").localeCompare(a.fecha || ""));
    pintarTabla();
  }, (error) => {
    aviso("error", "No se pudo leer Firebase: " + error.message);
  });
}

// =====================================================================
//  ZONA PARA ARRASTRAR Y SOLTAR XML
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
      importe: Math.round(importe * 100) / 100
    };
  });

  if (!conceptos.length) throw new Error("la factura no trae conceptos.");

  return {
    fecha,
    mes: fecha ? MESES[Number(fecha.slice(5, 7)) - 1] : "",
    folio: (serie && folio) ? `${serie}-${folio}` : (folio || uuid),
    uuid,
    proveedor: emisor ? (emisor.getAttribute("Nombre") || "").trim() : "",
    rfcEmisor: emisor ? (emisor.getAttribute("Rfc") || "") : "",
    conceptos
  };
}

// =====================================================================
//  GUARDAR EN FIREBASE (una fila por cada producto de la factura)
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
//  TABLA + BUSCADOR
// =====================================================================
buscador.addEventListener("input", pintarTabla);

const dinero = new Intl.NumberFormat("es-MX", { style: "currency", currency: "MXN" });
const numero = new Intl.NumberFormat("es-MX", { maximumFractionDigits: 3 });

function limpiar(t) {
  // Quita acentos y mayúsculas para que "compania" encuentre "COMPAÑÍA"
  return String(t ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function escapar(t) {
  return String(t ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function fechaBonita(f) {
  return f && f.length === 10 ? `${f.slice(8, 10)}/${f.slice(5, 7)}/${f.slice(0, 4)}` : (f || "");
}

function pintarTabla() {
  // Cada palabra escrita debe aparecer en algún lado de la fila
  const palabras = limpiar(buscador.value).split(/\s+/).filter(Boolean);
  const visibles = registros.filter((r) => {
    const textoFila = limpiar([r.mes, r.fecha, fechaBonita(r.fecha), r.folio, r.uuid, r.proveedor,
                               r.rfcEmisor, r.descripcion, r.unidad, r.cantidad, r.precioUnitario].join(" "));
    return palabras.every((p) => textoFila.includes(p));
  });

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
      <td><button class="borrar" data-id="${r.id}" title="Borrar esta fila">🗑</button></td>
    </tr>`;
  }).join("") || `<tr><td colspan="10" style="text-align:center;padding:20px">Sin registros</td></tr>`;

  $("totalImporte").textContent = dinero.format(total);
  $("contador").textContent = `Mostrando ${visibles.length} de ${registros.length} registros`;
}

// Borrar una fila (por si se cargó algo por error)
cuerpo.addEventListener("click", async (e) => {
  const boton = e.target.closest(".borrar");
  if (!boton) return;
  if (!confirm("¿Borrar esta fila? No se puede deshacer.")) return;
  await deleteDoc(doc(db, coleccionActual, boton.dataset.id));
});

function aviso(tipo, texto) {
  const div = document.createElement("div");
  div.className = `msg ${tipo}`;
  div.textContent = texto;
  $("mensajes").appendChild(div);
}

// =====================================================================
//  CARGA INICIAL DEL HISTORIAL DE EXCEL (se usa UNA sola vez)
//  En la consola (F12) escribe:   cargarHistorialInicial("adquisiciones")
//  o bien:                        cargarHistorialInicial("compras_centro")
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
