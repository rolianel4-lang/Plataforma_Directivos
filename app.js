// URL DE TU APLICACIÓN WEB DE APPS SCRIPT
const API_URL = "https://script.google.com/macros/s/AKfycbyAyMWew-j0TwHmwUyyS-VaYqs84Tj8-_roZ2gV8ACz4lzdFWpRmO5m-153jQyS71oX/exec";

// HUELLA DIGITAL ÚNICA DEL DISPOSITIVO EN LOCALSTORAGE
function obtenerDeviceId() {
  let devId = localStorage.getItem("dir_app_device_id");
  if (!devId) {
    devId = "DEV_" + Date.now() + "_" + Math.random().toString(36).substring(2, 12);
    localStorage.setItem("dir_app_device_id", devId);
  }
  return devId;
}

// CLIENTE FETCH HACIA APPS SCRIPT (TEXT/PLAIN EVITA PREFLIGHT CORS EN GITHUB PAGES)
async function llamarAPI(payload) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "text/plain;charset=utf-8"
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok) {
    throw new Error("Error de red al conectar con Google Sheets.");
  }
  return await response.json();
}

// ESTADO GLOBAL GENERAL
let usuarioActual = null;
let documentosDisponibles = [];
let modoActivoApp = "GRUPAL";

// VARIABLES MODO GRUPAL
let docSeleccionado = "";
let modalidadSeleccionada = "Teorica";
let ordenSeleccionado = "Correlativo";
let opcionElegidaLocal = null;
let yaEnvioVotoLocal = false;
let indicePreguntaRenderizada = -1;
let faseRenderizada = "";
let pollingInterval = null;
let syncEnProgreso = false;

// VARIABLES MODO INDIVIDUAL
let indIdSesionActual = "";
let indDocSeleccionado = "";
let indModalidadSeleccionada = "Teorica";
let indOrdenSeleccionado = "Correlativo";
let indPreguntas = [];
let indIndiceActual = 0;
let indOpcionSeleccionada = null;
let indPuntajeCorrectas = 0;
let indPuntajeIncorrectas = 0;
let indFalladasIds = [];
let indTimerInterval = null;
let indTiempoRestanteSegundos = 0;
let indTiempoTotalTranscurrido = 0;

// CONTROL DE MODO COMPACTO EN PANTALLA DE PREGUNTAS
function activarModoEnfoqueQuiz(activo) {
  if (activo) {
    document.body.classList.add('in-quiz-mode');
  } else {
    document.body.classList.remove('in-quiz-mode');
  }
}

// AUTOCARGAR CORREO SI YA INICIÓ EN ESTE DISPOSITIVO
window.onload = function() {
  const savedEmail = localStorage.getItem("dir_app_email");
  if (savedEmail) {
    document.getElementById('inp-correo').value = savedEmail;
  }
};

// 1. LOGIN CON MODO ESTRICTO
async function ingresarSala() {
  const correo = document.getElementById('inp-correo').value.trim();
  const pass = document.getElementById('inp-pass').value.trim();
  const errBox = document.getElementById('login-error');
  errBox.innerText = "";

  if (!correo || !pass) {
    errBox.innerText = "Por favor ingresa tu correo y contraseña.";
    return;
  }

  const btn = document.getElementById('btn-login');
  btn.disabled = true;
  btn.innerText = "Verificando seguridad y dispositivo...";

  try {
    const deviceId = obtenerDeviceId();
    const tokenGuardado = localStorage.getItem("dir_app_token_" + correo.toLowerCase()) || "";

    const res = await llamarAPI({
      action: "login",
      correo: correo,
      password: pass,
      deviceId: deviceId,
      tokenGuardado: tokenGuardado
    });

    btn.disabled = false;
    btn.innerText = "Ingresar a la Plataforma";

    if (!res.ok) {
      errBox.innerText = res.error;
      return;
    }

    usuarioActual = res.usuario;
    localStorage.setItem("dir_app_email", usuarioActual.correo);
    localStorage.setItem("dir_app_token_" + usuarioActual.correo, usuarioActual.token);

    documentosDisponibles = res.documentos || [];
    document.getElementById('login-screen').style.display = 'none';
    
    const badge = document.getElementById('user-badge');
    badge.style.display = 'inline-block';
    badge.innerText = `${usuarioActual.nombre} (${usuarioActual.rol})`;
    document.getElementById('btn-logout').style.display = 'inline-block';

    renderizarHistorialGrupal(res.historialGrupal || []);

    if (usuarioActual.puedeIndividual) {
      document.getElementById('mode-switcher-bar').style.display = 'flex';
      cargarBibliografiasIndividual(documentosDisponibles);
      renderizarHistorialIndividual(res.historialIndividual || []);
    }

    if (usuarioActual.rol === "ORGANIZADOR") {
      document.getElementById('organizer-panel').style.display = 'block';
      cargarBibliografias(documentosDisponibles);
    } else {
      document.getElementById('participant-wait-panel').style.display = 'block';
    }

    cambiarModoApp("GRUPAL");
    sincronizarEstado();
    pollingInterval = setInterval(sincronizarEstado, 2500);
  } catch (err) {
    btn.disabled = false;
    btn.innerText = "Ingresar a la Plataforma";
    errBox.innerText = "Error de conexión: " + err.message;
  }
}

async function cerrarSesion() {
  if (!usuarioActual) return;
  if (pollingInterval) clearInterval(pollingInterval);
  try {
    await llamarAPI({
      action: "logout",
      correo: usuarioActual.correo,
      token: usuarioActual.token
    });
  } catch (e) {}
  localStorage.removeItem("dir_app_token_" + usuarioActual.correo);
  location.reload();
}

function manejarExpiracionSesion(mensaje) {
  if (pollingInterval) clearInterval(pollingInterval);
  alert(mensaje || "Tu sesión fue cerrada o liberada por el organizador.");
  if (usuarioActual) {
    localStorage.removeItem("dir_app_token_" + usuarioActual.correo);
  }
  location.reload();
}

function cambiarModoApp(modo) {
  modoActivoApp = modo;
  document.getElementById('tab-grupal').classList.toggle('active', modo === "GRUPAL");
  document.getElementById('tab-individual').classList.toggle('active', modo === "INDIVIDUAL");

  if (modo === "GRUPAL") {
    document.getElementById('group-mode-container').style.display = 'block';
    document.getElementById('individual-mode-container').style.display = 'none';
    sincronizarEstado();
  } else {
    document.getElementById('group-mode-container').style.display = 'none';
    document.getElementById('individual-mode-container').style.display = 'block';
    document.getElementById('btn-org-abort').style.display = 'none';
    const enQuizInd = document.getElementById('ind-quiz-screen').style.display === 'block';
    activarModoEnfoqueQuiz(enQuizInd);
    refrescarHistoriales();
  }
}

async function refrescarHistoriales() {
  if (!usuarioActual) return;
  try {
    const data = await llamarAPI({
      action: "historial",
      correo: usuarioActual.correo,
      token: usuarioActual.token
    });
    if (!data.ok) return;
    renderizarHistorialGrupal(data.historialGrupal || []);
    if (usuarioActual.puedeIndividual) {
      renderizarHistorialIndividual(data.historialIndividual || []);
    }
  } catch (e) {}
}

// FINALIZAR ACTIVIDAD INCONCLUSA DESDE EL HISTORIAL
async function finalizarActividadDesdeHistorial(tipo, idSesion, btnElement) {
  if (!confirm("¿Marcar esta actividad inconclusa como finalizada? Ya no aparecerá como pendiente para continuar.")) {
    return;
  }

  if (btnElement) {
    btnElement.disabled = true;
    btnElement.innerText = "Finalizando...";
  }

  try {
    const res = await llamarAPI({
      action: "finalizarHistorial",
      correo: usuarioActual.correo,
      token: usuarioActual.token,
      tipo: tipo,
      idSesion: idSesion
    });

    if (!res.ok) {
      alert(res.error || "No se pudo finalizar la actividad.");
      if (btnElement) {
        btnElement.disabled = false;
        btnElement.innerText = "✓ Finalizar actividad";
      }
      return;
    }

    await refrescarHistoriales();
  } catch (e) {
    alert("Error de conexión: " + e.message);
    if (btnElement) {
      btnElement.disabled = false;
      btnElement.innerText = "✓ Finalizar actividad";
    }
  }
}

// =========================================================
// RENDERIZADO DE HISTORIALES
// =========================================================
function renderizarHistorialGrupal(lista) {
  const esOrg = usuarioActual && usuarioActual.rol === "ORGANIZADOR";
  const card = document.getElementById(esOrg ? 'org-group-history-card' : 'part-group-history-card');
  const container = document.getElementById(esOrg ? 'org-group-history-list' : 'part-group-history-list');

  if (!lista || lista.length === 0) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';
  container.innerHTML = lista.map(s => {
    const esInconclusa = (s.estado === "EN_CURSO" && s.indiceActual < s.totalPreguntas);
    return `
      <div class="history-item ${esInconclusa ? 'in-progress' : ''}">
        <div>
          <strong>${s.nombreSesion}</strong> (${s.documento.replace(/_/g, ' ')})
          <div class="history-meta">
            Fecha: ${s.fecha} | Avance: ${s.indiceActual}/${s.totalPreguntas} | Falladas por el grupo: ${s.cantidadFalladas}
          </div>
        </div>
        ${esOrg ? `
          <div class="history-actions">
            ${esInconclusa ? `<button class="btn-mini resume" onclick="retomarOReforzarGrupal('CONTINUAR_GRUPAL', '${s.idSesion}')">▶ Continuar (${s.indiceActual + 1}/${s.totalPreguntas})</button>` : ''}
            ${esInconclusa ? `<button class="btn-mini finish" onclick="finalizarActividadDesdeHistorial('GRUPAL', '${s.idSesion}', this)">✓ Finalizar actividad</button>` : ''}
            ${s.cantidadFalladas > 0 ? `<button class="btn-mini reinforce" onclick="retomarOReforzarGrupal('REFUERZO_GRUPAL', '${s.idSesion}')">🎯 Reforzar Falladas (${s.cantidadFalladas})</button>` : ''}
          </div>
        ` : ''}
      </div>
    `;
  }).join('');
}

function renderizarHistorialIndividual(lista) {
  const card = document.getElementById('ind-history-card');
  const container = document.getElementById('ind-history-list');

  if (!lista || lista.length === 0) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';
  container.innerHTML = lista.map(s => {
    const esInconclusa = (s.estado === "EN_CURSO" && s.indiceActual < s.totalPreguntas);
    return `
      <div class="history-item ${esInconclusa ? 'in-progress' : ''}">
        <div>
          <strong>${s.documento.replace(/_/g, ' ')}</strong> — ${s.modalidad}
          <div class="history-meta">
            ${s.fecha} | Progreso: ${s.indiceActual}/${s.totalPreguntas} | Aciertos: ${s.correctas} | Falladas: ${s.cantidadFalladas}
          </div>
        </div>
        <div class="history-actions">
          ${esInconclusa ? `<button class="btn-mini resume" onclick="retomarSesionInd('${s.idSesion}')">▶ Continuar donde dejé (${s.indiceActual + 1}/${s.totalPreguntas})</button>` : ''}
          ${esInconclusa ? `<button class="btn-mini finish" onclick="finalizarActividadDesdeHistorial('INDIVIDUAL', '${s.idSesion}', this)">✓ Finalizar actividad</button>` : ''}
          ${s.cantidadFalladas > 0 ? `<button class="btn-mini reinforce" onclick="iniciarRefuerzoInd('${s.documento}', '${s.idSesion}')">🎯 Reforzar Falladas (${s.cantidadFalladas})</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

// =========================================================
// LÓGICA MODO GRUPAL
// =========================================================
function cargarBibliografias(docs) {
  const container = document.getElementById('biblio-container');
  container.innerHTML = '';
  docs.forEach(doc => {
    const btn = document.createElement('button');
    btn.className = 'select-btn';
    btn.innerText = doc.replace(/_/g, ' ');
    btn.onclick = () => {
      docSeleccionado = doc;
      document.querySelectorAll('#biblio-container .select-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('btn-iniciar-grupal').disabled = false;
    };
    container.appendChild(btn);
  });
}

function setModalidad(mod, btn) {
  modalidadSeleccionada = mod;
  document.querySelectorAll('#mod-container .select-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
}

function setOrden(ord, btn) {
  ordenSeleccionado = ord;
  document.querySelectorAll('#orden-container .select-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  const rangoBox = document.getElementById('grp-rango-box');
  if (rangoBox) {
    rangoBox.style.display = (ord === "Correlativo") ? "block" : "none";
  }
}

function toggleCantidadManualGrupal() {
  const sel = document.getElementById('cmb-cantidad').value;
  const inp = document.getElementById('inp-cantidad-manual-grupal');
  inp.style.display = (sel === "MANUAL") ? "block" : "none";
  if (sel === "MANUAL") inp.focus();
}

async function iniciarSesionGrupal() {
  const selCant = document.getElementById('cmb-cantidad').value;
  let cantidadFinal = selCant;

  if (selCant === "MANUAL") {
    const valManual = parseInt(document.getElementById('inp-cantidad-manual-grupal').value, 10);
    if (isNaN(valManual) || valManual < 1) {
      alert("Por favor escribe un número válido de preguntas en el campo manual.");
      return;
    }
    cantidadFinal = valManual;
  }

  const desdeNum = ordenSeleccionado === "Correlativo" ? document.getElementById('grp-desde-num').value.trim() : "";
  const hastaNum = ordenSeleccionado === "Correlativo" ? document.getElementById('grp-hasta-num').value.trim() : "";

  if (desdeNum !== "" && hastaNum !== "" && parseInt(hastaNum, 10) < parseInt(desdeNum, 10)) {
    alert("La pregunta final ('Hasta') no puede ser menor que la pregunta inicial ('Desde').");
    return;
  }

  const btn = document.getElementById('btn-iniciar-grupal');
  btn.disabled = true;
  btn.innerText = "Preparando sala para todos...";

  const config = {
    modoInicio: "NUEVA",
    nombreSesion: document.getElementById('inp-nombre-sesion-grupal').value,
    documento: docSeleccionado,
    modalidad: modalidadSeleccionada,
    orden: ordenSeleccionado,
    cantidad: cantidadFinal,
    desdeNum: desdeNum,
    hastaNum: hastaNum,
    minutosLectura: document.getElementById('cmb-tiempo-lectura').value,
    minutosPregunta: document.getElementById('cmb-tiempo-pregunta').value
  };

  try {
    const res = await llamarAPI({
      action: "configurarGrupal",
      correo: usuarioActual.correo,
      token: usuarioActual.token,
      config: config
    });
    btn.disabled = false;
    btn.innerText = "Iniciar Nueva Sesión Grupal";
    if (!res.ok) alert(res.error);
    else sincronizarEstado();
  } catch (e) {
    btn.disabled = false;
    btn.innerText = "Iniciar Nueva Sesión Grupal";
    alert(e.message);
  }
}

async function retomarOReforzarGrupal(modoInicio, idSesionGrupal) {
  try {
    const res = await llamarAPI({
      action: "configurarGrupal",
      correo: usuarioActual.correo,
      token: usuarioActual.token,
      config: { modoInicio: modoInicio, idSesionGrupal: idSesionGrupal }
    });
    if (!res.ok) alert(res.error);
    else sincronizarEstado();
  } catch (e) {
    alert(e.message);
  }
}

async function sincronizarEstado() {
  if (!usuarioActual || syncEnProgreso) return;
  syncEnProgreso = true;
  try {
    const estado = await llamarAPI({
      action: "sync",
      correo: usuarioActual.correo,
      token: usuarioActual.token
    });

    if (!estado.ok) {
      if (estado.sesionInvalida) {
        manejarExpiracionSesion(estado.error);
      }
      return;
    }
    renderizarEstadoGlobal(estado);
  } catch (e) {
    // Ignorar errores momentáneos de red en polling
  } finally {
    syncEnProgreso = false;
  }
}

function renderizarEstadoGlobal(estado) {
  const esOrg = usuarioActual.rol === "ORGANIZADOR";

  if (modoActivoApp === "INDIVIDUAL" && !esOrg && estado.fase !== "LOBBY" && estado.miEstado) {
    cambiarModoApp("GRUPAL");
  }

  if (modoActivoApp !== "GRUPAL") return;

  if (!estado.miEstado && estado.fase !== "LOBBY") {
    manejarExpiracionSesion("Has sido desconectado de la sala grupal por el organizador.");
    return;
  }

  const btnAbort = document.getElementById('btn-org-abort');
  if (esOrg && estado.fase !== "LOBBY") {
    btnAbort.style.display = 'inline-block';
  } else {
    btnAbort.style.display = 'none';
  }

  document.getElementById('lobby-screen').style.display = 'none';
  document.getElementById('active-session-screen').style.display = 'none';
  document.getElementById('final-screen').style.display = 'none';

  // --- FASE: LOBBY ---
  if (estado.fase === "LOBBY") {
    activarModoEnfoqueQuiz(false);
    if (faseRenderizada !== "LOBBY") {
      refrescarHistoriales();
    }
    faseRenderizada = "LOBBY";
    indicePreguntaRenderizada = -1;
    document.getElementById('lobby-screen').style.display = 'block';
    const conectadosCount = estado.listaHabilitadosLobby.filter(u => u.conectado).length;
    document.getElementById('lbl-conectados-count').innerText = conectadosCount;
    document.getElementById('lbl-max-count').innerText = estado.totalHabilitadosHoja;

    const list = document.getElementById('lobby-participants');
    list.innerHTML = estado.listaHabilitadosLobby.map(u => `
      <div class="participant-chip ${u.conectado ? '' : 'offline'}">
        <span class="status-dot ${u.conectado ? 'ready' : ''}"></span>
        <span>${u.nombre} ${u.rol === 'ORGANIZADOR' ? '👑' : ''} (${u.conectado ? 'En sala ✓' : 'Pendiente...'})</span>
        ${(esOrg && u.correo !== usuarioActual.correo && u.tieneSesionActiva)
          ? `<button class="btn-unlock" title="Liberar dispositivo si el usuario cambió de equipo" onclick="liberarAccesoUsuario('${u.correo}', '${u.nombre}')">🔓 Liberar</button>`
          : ''}
      </div>
    `).join('');
    return;
  }

  // --- FASE: FINAL ---
  if (estado.fase === "FINAL") {
    activarModoEnfoqueQuiz(false);
    faseRenderizada = "FINAL";
    document.getElementById('final-screen').style.display = 'block';
    const tbody = document.getElementById('tbody-final-ranking');
    tbody.innerHTML = estado.participantes.map((p, idx) => `
      <tr>
        <td><strong>#${idx + 1}</strong></td>
        <td>${p.nombre}</td>
        <td><strong style="color: var(--primary);">${p.puntaje} pts</strong></td>
      </tr>
    `).join('');

    if (esOrg) {
      document.getElementById('org-restart-controls').style.display = 'block';
    }
    return;
  }

  // --- FASES ACTIVAS (VISTA COMPACTA) ---
  activarModoEnfoqueQuiz(true);
  document.getElementById('active-session-screen').style.display = 'block';
  document.getElementById('lbl-nombre-sesion-activa').innerText = estado.nombreSesion || "Sesión Grupal";
  document.getElementById('lbl-doc-sesion-activa').innerText = estado.documento.replace(/_/g, ' ');
  document.getElementById('lbl-progreso').innerText = `${estado.pregunta.numero} / ${estado.pregunta.total}`;
  document.getElementById('lbl-mi-score').innerText = `${estado.miEstado ? estado.miEstado.puntaje : 0} pts`;
  document.getElementById('lbl-timer').innerText = formatearSegundos(estado.tiempoRestante);

  document.getElementById('phase-reading').style.display = 'none';
  document.getElementById('phase-question').style.display = 'none';
  document.getElementById('phase-round-results').style.display = 'none';

  // SUB-FASE 1: LECTURA
  if (estado.fase === "LECTURA") {
    document.getElementById('phase-reading').style.display = 'block';
    document.getElementById('read-fuente').innerText = estado.pregunta.fuenteTexto || estado.pregunta.pagina;
    document.getElementById('read-pistas').innerText = estado.pregunta.pistas || "Revisa el concepto principal en la página indicada.";

    const btnListo = document.getElementById('btn-listo-lectura');
    if (estado.miEstado && estado.miEstado.listoLectura) {
      btnListo.disabled = true;
      btnListo.innerText = "✓ Ya confirmaste lectura (Esperando al grupo...)";
    } else {
      btnListo.disabled = false;
      btnListo.innerText = "✓ Ya terminé de leer, estoy listo";
    }

    document.getElementById('reading-status-list').innerHTML = estado.participantes.map(p => `
      <div class="participant-chip">
        <span class="status-dot ${p.listoLectura ? 'ready' : ''}"></span>
        <span>${p.nombre}: ${p.listoLectura ? 'Listo' : 'Leyendo...'}</span>
        ${(esOrg && p.correo !== usuarioActual.correo) 
          ? `<button class="btn-kick" title="Quitar de la sala si se desconectó" onclick="quitarUsuario('${p.correo}', '${p.nombre}')">✕</button>` 
          : ''}
      </div>
    `).join('');

    document.getElementById('org-reading-controls').style.display = esOrg ? 'flex' : 'none';
    faseRenderizada = "LECTURA";
  }

  // SUB-FASE 2: PREGUNTA
  if (estado.fase === "PREGUNTA") {
    document.getElementById('phase-question').style.display = 'block';
    document.getElementById('lbl-pregunta').innerText = estado.pregunta.pregunta;
    document.getElementById('lbl-fuente-sub').innerText = estado.pregunta.fuenteTexto || estado.pregunta.pagina;
    document.getElementById('lbl-pistas-sub').innerText = estado.pregunta.pistas || "Sin pistas adicionales.";

    if (faseRenderizada !== "PREGUNTA" || indicePreguntaRenderizada !== estado.pregunta.numero) {
      opcionElegidaLocal = null;
      yaEnvioVotoLocal = estado.miEstado ? estado.miEstado.yaRespondio : false;
      indicePreguntaRenderizada = estado.pregunta.numero;
      faseRenderizada = "PREGUNTA";

      const container = document.getElementById('options-container');
      container.innerHTML = '';
      Object.keys(estado.pregunta.opciones).forEach(key => {
        const btn = document.createElement('button');
        btn.className = 'opt-btn';
        btn.innerHTML = `<strong>${key})</strong> ${estado.pregunta.opciones[key]}`;
        btn.disabled = yaEnvioVotoLocal;
        btn.onclick = () => {
          if (yaEnvioVotoLocal) return;
          opcionElegidaLocal = key;
          document.querySelectorAll('#options-container .opt-btn').forEach(b => b.classList.remove('selected'));
          btn.classList.add('selected');
          document.getElementById('btn-enviar-voto').disabled = false;
        };
        container.appendChild(btn);
      });
    }

    const btnVoto = document.getElementById('btn-enviar-voto');
    const waitMsg = document.getElementById('wait-others-msg');
    if (yaEnvioVotoLocal || (estado.miEstado && estado.miEstado.yaRespondio)) {
      btnVoto.style.display = 'none';
      waitMsg.style.display = 'block';
      document.querySelectorAll('#options-container .opt-btn').forEach(b => b.disabled = true);
    } else {
      btnVoto.style.display = 'block';
      btnVoto.disabled = !opcionElegidaLocal;
      waitMsg.style.display = 'none';
    }

    document.getElementById('answering-status-list').innerHTML = estado.participantes.map(p => `
      <div class="participant-chip">
        <span class="status-dot ${p.yaRespondio ? 'ready' : ''}"></span>
        <span>${p.nombre}: ${p.yaRespondio ? 'Respondió ✓' : 'Pensando...'}</span>
        ${(esOrg && p.correo !== usuarioActual.correo) 
          ? `<button class="btn-kick" title="Quitar de la sala si se desconectó" onclick="quitarUsuario('${p.correo}', '${p.nombre}')">✕</button>` 
          : ''}
      </div>
    `).join('');

    document.getElementById('org-question-controls').style.display = esOrg ? 'flex' : 'none';
  }

  // SUB-FASE 3: RESULTADOS DE LA RONDA
  if (estado.fase === "RESULTADOS_RONDA") {
    faseRenderizada = "RESULTADOS_RONDA";
    document.getElementById('phase-round-results').style.display = 'block';
    document.getElementById('lbl-timer').innerText = "00:00";

    document.getElementById('res-ronda-pregunta').innerText = estado.pregunta.pregunta;
    const letraCorrecta = estado.pregunta.correcta;
    const textoCorrecta = estado.pregunta.opciones ? estado.pregunta.opciones[letraCorrecta] : "";
    document.getElementById('res-ronda-correcta').innerText = `${letraCorrecta}) ${textoCorrecta}`;
    document.getElementById('res-ronda-explicacion').innerText = estado.pregunta.explicacion;

    const tbody = document.getElementById('tbody-round-results');
    tbody.innerHTML = estado.participantes.map(p => `
      <tr>
        <td><strong>${p.nombre}</strong></td>
        <td>${p.respuesta ? p.respuesta : 'Sin responder'}</td>
        <td>
          ${p.esCorrecta 
            ? '<span class="badge-ok">✓ Correcto (+10)</span>' 
            : '<span class="badge-fail">✗ Incorrecto</span>'}
        </td>
        <td><strong>${p.puntaje} pts</strong></td>
      </tr>
    `).join('');

    document.getElementById('org-next-controls').style.display = esOrg ? 'block' : 'none';
    document.getElementById('part-next-wait').style.display = esOrg ? 'none' : 'block';
  }
}

async function confirmarLecturaLista() {
  document.getElementById('btn-listo-lectura').disabled = true;
  await llamarAPI({
    action: "marcarListo",
    correo: usuarioActual.correo,
    token: usuarioActual.token
  });
  sincronizarEstado();
}

async function enviarRespuesta() {
  if (!opcionElegidaLocal) return;
  yaEnvioVotoLocal = true;
  document.getElementById('btn-enviar-voto').style.display = 'none';
  document.getElementById('wait-others-msg').style.display = 'block';
  document.querySelectorAll('#options-container .opt-btn').forEach(b => b.disabled = true);

  await llamarAPI({
    action: "enviarVoto",
    correo: usuarioActual.correo,
    token: usuarioActual.token,
    opcion: opcionElegidaLocal
  });
  sincronizarEstado();
}

async function quitarUsuario(correoObjetivo, nombre) {
  if (confirm(`¿Quitar a ${nombre} de la sala actual para continuar sin esperar su respuesta?`)) {
    await llamarAPI({
      action: "expulsar",
      correoAdmin: usuarioActual.correo,
      tokenAdmin: usuarioActual.token,
      correoObjetivo: correoObjetivo
    });
    sincronizarEstado();
  }
}

async function liberarAccesoUsuario(correoObjetivo, nombre) {
  if (confirm(`¿Liberar el dispositivo vinculado de ${nombre} para que pueda iniciar sesión desde otro equipo?`)) {
    await llamarAPI({
      action: "liberarDispositivo",
      correoAdmin: usuarioActual.correo,
      tokenAdmin: usuarioActual.token,
      correoObjetivo: correoObjetivo
    });
    alert(`Dispositivo de ${nombre} liberado correctamente.`);
    sincronizarEstado();
  }
}

function finalizarTodoConfirmar() {
  if (confirm("¿Guardar progreso hasta aquí, finalizar la sesión grupal y volver a la sala principal?")) {
    enviarComandoOrg('REINICIAR_SALA');
  }
}

async function enviarComandoOrg(comando) {
  await llamarAPI({
    action: "comandoOrg",
    correoAdmin: usuarioActual.correo,
    tokenAdmin: usuarioActual.token,
    comando: comando
  });
  sincronizarEstado();
}

// =========================================================
// LÓGICA MODO INDIVIDUAL
// =========================================================
function cargarBibliografiasIndividual(documentos) {
  const container = document.getElementById('ind-biblio-container');
  container.innerHTML = '';

  if (!documentos || documentos.length === 0) {
    container.innerHTML = '<div>No se encontraron documentos disponibles.</div>';
    return;
  }

  documentos.forEach(doc => {
    const btn = document.createElement('button');
    btn.className = 'select-btn';
    btn.innerText = doc.replace(/_/g, ' ');
    btn.onclick = () => {
      indDocSeleccionado = doc;
      document.querySelectorAll('#ind-biblio-container .select-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const stepConfig = document.getElementById('ind-step-config');
      stepConfig.style.opacity = '1';
      stepConfig.style.pointerEvents = 'auto';
      document.getElementById('ind-btn-iniciar').disabled = false;
      document.getElementById('ind-btn-rapidito').disabled = false;
    };
    container.appendChild(btn);
  });
}

function setIndModalidad(mod, btnElement) {
  indModalidadSeleccionada = mod;
  document.querySelectorAll('#ind-mod-container .select-btn').forEach(b => b.classList.remove('active'));
  btnElement.classList.add('active');
}

function setIndOrden(ord, btnElement) {
  indOrdenSeleccionado = ord;
  document.querySelectorAll('#ind-orden-container .select-btn').forEach(b => b.classList.remove('active'));
  btnElement.classList.add('active');

  const rangoBox = document.getElementById('ind-rango-box');
  if (rangoBox) {
    rangoBox.style.display = (ord === "Correlativo") ? "block" : "none";
  }
}

function toggleCantidadManualInd() {
  const sel = document.getElementById('ind-cmb-cantidad').value;
  const inp = document.getElementById('ind-inp-cantidad-manual');
  inp.style.display = (sel === "MANUAL") ? "block" : "none";
  if (sel === "MANUAL") inp.focus();
}

async function iniciarEstudioIndividual(tipo) {
  let cantidadFinal = document.getElementById('ind-cmb-cantidad').value;
  let desdeNum = "";
  let hastaNum = "";

  if (tipo === "NORMAL") {
    if (cantidadFinal === "MANUAL") {
      const valManual = parseInt(document.getElementById('ind-inp-cantidad-manual').value, 10);
      if (isNaN(valManual) || valManual < 1) {
        alert("Por favor escribe un número válido de preguntas en el campo manual.");
        return;
      }
      cantidadFinal = valManual;
    }

    if (indOrdenSeleccionado === "Correlativo") {
      desdeNum = document.getElementById('ind-desde-num').value.trim();
      hastaNum = document.getElementById('ind-hasta-num').value.trim();
      if (desdeNum !== "" && hastaNum !== "" && parseInt(hastaNum, 10) < parseInt(desdeNum, 10)) {
        alert("La pregunta final ('Hasta') no puede ser menor que la pregunta inicial ('Desde').");
        return;
      }
    }
  }

  document.getElementById('ind-setup-screen').style.display = 'none';
  document.getElementById('ind-loading-screen').style.display = 'block';

  const params = {
    tipo: tipo,
    documento: indDocSeleccionado,
    modalidad: indModalidadSeleccionada,
    orden: indOrdenSeleccionado,
    cantidad: cantidadFinal,
    desdeNum: desdeNum,
    hastaNum: hastaNum
  };

  try {
    const res = await llamarAPI({
      action: "iniciarIndividual",
      correo: usuarioActual.correo,
      token: usuarioActual.token,
      params: params
    });
    arrancarSesionIndividualDesdeServidor(res);
  } catch (e) {
    alert(e.message);
    reiniciarAppIndividual();
  }
}

async function retomarSesionInd(idSesion) {
  document.getElementById('ind-setup-screen').style.display = 'none';
  document.getElementById('ind-loading-screen').style.display = 'block';

  try {
    const res = await llamarAPI({
      action: "retomarIndividual",
      correo: usuarioActual.correo,
      token: usuarioActual.token,
      idSesion: idSesion
    });
    arrancarSesionIndividualDesdeServidor(res);
  } catch (e) {
    alert(e.message);
    reiniciarAppIndividual();
  }
}

async function iniciarRefuerzoInd(documento, idSesionOrigen) {
  indDocSeleccionado = documento;
  document.getElementById('ind-setup-screen').style.display = 'none';
  document.getElementById('ind-loading-screen').style.display = 'block';

  try {
    const res = await llamarAPI({
      action: "iniciarIndividual",
      correo: usuarioActual.correo,
      token: usuarioActual.token,
      params: {
        tipo: "REFUERZO",
        documento: documento,
        idSesionOrigen: idSesionOrigen
      }
    });
    arrancarSesionIndividualDesdeServidor(res);
  } catch (e) {
    alert(e.message);
    reiniciarAppIndividual();
  }
}

function reforzarFalladasActuales() {
  document.getElementById('ind-results-screen').style.display = 'none';
  iniciarRefuerzoInd(indDocSeleccionado, indIdSesionActual);
}

function arrancarSesionIndividualDesdeServidor(res) {
  document.getElementById('ind-loading-screen').style.display = 'none';

  if (!res.ok || !res.preguntas || res.preguntas.length === 0) {
    alert(res.error || "No se pudieron cargar las preguntas.");
    reiniciarAppIndividual();
    return;
  }

  indIdSesionActual = res.idSesion;
  indPreguntas = res.preguntas;
  indIndiceActual = res.indiceActual || 0;
  indPuntajeCorrectas = (res.correctas || 0) * 10;
  indPuntajeIncorrectas = res.incorrectas || 0;
  indFalladasIds = res.falladas || [];
  indTiempoTotalTranscurrido = 0;

  if (indTimerInterval) clearInterval(indTimerInterval);
  const minutos = parseInt(document.getElementById('ind-cmb-tiempo').value, 10);
  if (minutos > 0) {
    indTiempoRestanteSegundos = minutos * 60;
    iniciarRelojIndividual();
  } else {
    document.getElementById('ind-lbl-timer').innerText = "Sin límite";
  }

  activarModoEnfoqueQuiz(true);
  document.getElementById('ind-quiz-screen').style.display = 'block';
  mostrarPreguntaIndividual();
}

function iniciarRelojIndividual() {
  actualizarDisplayRelojInd();
  indTimerInterval = setInterval(() => {
    indTiempoRestanteSegundos--;
    indTiempoTotalTranscurrido++;
    actualizarDisplayRelojInd();

    if (indTiempoRestanteSegundos <= 0) {
      clearInterval(indTimerInterval);
      alert("¡El tiempo se ha agotado!");
      finalizarEvaluacionIndividual(true);
    }
  }, 1000);
}

function actualizarDisplayRelojInd() {
  if (indTiempoRestanteSegundos < 0) return;
  document.getElementById('ind-lbl-timer').innerText = formatearSegundos(indTiempoRestanteSegundos);
}

function mostrarPreguntaIndividual() {
  const q = indPreguntas[indIndiceActual];
  indOpcionSeleccionada = null;

  document.getElementById('ind-lbl-progreso').innerText = `${indIndiceActual + 1} / ${indPreguntas.length}`;
  document.getElementById('ind-lbl-score').innerText = `${indPuntajeCorrectas} pts`;

  document.getElementById('ind-lbl-pregunta').innerText = q.pregunta;
  document.getElementById('ind-lbl-fuente-texto').innerText = q.fuenteTexto || q.pagina;
  document.getElementById('ind-lbl-pistas').innerText = q.pistas;

  // Cerrar el acordeón al pasar a una nueva pregunta para maximizar vista
  const acc = document.getElementById('ind-ref-accordion');
  if (acc) acc.removeAttribute('open');

  const container = document.getElementById('ind-options-container');
  container.innerHTML = '';

  const fb = document.getElementById('ind-feedback-box');
  fb.style.display = 'none';
  fb.className = 'feedback-box';
  document.getElementById('ind-btn-comprobar').style.display = 'block';
  document.getElementById('ind-btn-comprobar').disabled = true;
  document.getElementById('ind-btn-siguiente').style.display = 'none';

  Object.keys(q.opciones).forEach(key => {
    const btn = document.createElement('button');
    btn.className = 'opt-btn';
    btn.innerHTML = `<strong>${key})</strong> ${q.opciones[key]}`;
    btn.onclick = () => {
      indOpcionSeleccionada = key;
      document.querySelectorAll('#ind-options-container .opt-btn').forEach(b => b.classList.remove('selected'));
      btn.classList.add('selected');
      document.getElementById('ind-btn-comprobar').disabled = false;
    };
    container.appendChild(btn);
  });
}

function comprobarRespuestaInd() {
  const q = indPreguntas[indIndiceActual];
  const btns = document.querySelectorAll('#ind-options-container .opt-btn');
  
  btns.forEach(btn => {
    btn.disabled = true;
    const texto = btn.innerText.trim();
    if (texto.startsWith(q.correcta + ')')) {
      btn.classList.add('correct');
    } else if (texto.startsWith(indOpcionSeleccionada + ')') && indOpcionSeleccionada !== q.correcta) {
      btn.classList.add('incorrect');
    }
  });

  const feedbackBox = document.getElementById('ind-feedback-box');
  document.getElementById('ind-lbl-explicacion').innerText = q.explicacion;
  feedbackBox.style.display = 'block';

  if (indOpcionSeleccionada === q.correcta) {
    indPuntajeCorrectas += 10;
  } else {
    feedbackBox.classList.add('incorrect-bg');
    indPuntajeIncorrectas++;
    if (!indFalladasIds.includes(q.id)) {
      indFalladasIds.push(q.id);
    }
  }

  document.getElementById('ind-lbl-score').innerText = `${indPuntajeCorrectas} pts`;
  document.getElementById('ind-btn-comprobar').style.display = 'none';
  document.getElementById('ind-btn-siguiente').style.display = 'block';

  const siguienteIdx = indIndiceActual + 1;
  const esFinal = siguienteIdx >= indPreguntas.length;
  llamarAPI({
    action: "guardarProgresoInd",
    correo: usuarioActual.correo,
    token: usuarioActual.token,
    datosProgreso: {
      idSesion: indIdSesionActual,
      indiceActual: siguienteIdx,
      correctas: indPuntajeCorrectas / 10,
      incorrectas: indPuntajeIncorrectas,
      falladas: indFalladasIds,
      estado: esFinal ? "FINALIZADO" : "EN_CURSO"
    }
  });
}

function siguientePreguntaInd() {
  indIndiceActual++;
  if (indIndiceActual < indPreguntas.length) {
    mostrarPreguntaIndividual();
  } else {
    finalizarEvaluacionIndividual(false);
  }
}

function finalizarEstudioCuandoQuiera() {
  if (confirm("¿Finalizar tu estudio ahora y ver los resultados de lo que has respondido? (Tu progreso quedará guardado en tu historial por si deseas continuar después).")) {
    finalizarEvaluacionIndividual(true);
  }
}

function finalizarEvaluacionIndividual(corteAnticipado) {
  if (indTimerInterval) clearInterval(indTimerInterval);
  activarModoEnfoqueQuiz(false);

  document.getElementById('ind-quiz-screen').style.display = 'none';
  document.getElementById('ind-results-screen').style.display = 'block';

  const correctasCant = indPuntajeCorrectas / 10;
  const respondidasCant = correctasCant + indPuntajeIncorrectas;
  const baseCalculo = respondidasCant > 0 ? respondidasCant : 1;
  const porcentaje = Math.round((correctasCant / baseCalculo) * 100);

  document.getElementById('ind-res-subtitulo').innerText = corteAnticipado
    ? `Respondiste ${respondidasCant} de ${indPreguntas.length} preguntas (Sesión guardada para continuar luego)`
    : `Completaste las ${indPreguntas.length} preguntas de la sesión`;

  document.getElementById('ind-res-porcentaje').innerText = `${porcentaje}%`;
  document.getElementById('ind-res-correctas').innerText = correctasCant;
  document.getElementById('ind-res-incorrectas').innerText = indPuntajeIncorrectas;
  document.getElementById('ind-res-tiempo').innerText = formatearSegundos(indTiempoTotalTranscurrido);

  const btnReforzar = document.getElementById('ind-btn-reforzar-ahora');
  btnReforzar.style.display = indFalladasIds.length > 0 ? 'block' : 'none';
}

function reiniciarAppIndividual() {
  if (indTimerInterval) clearInterval(indTimerInterval);
  activarModoEnfoqueQuiz(false);
  indDocSeleccionado = "";
  document.getElementById('ind-results-screen').style.display = 'none';
  document.getElementById('ind-quiz-screen').style.display = 'none';
  document.getElementById('ind-setup-screen').style.display = 'block';
  
  document.querySelectorAll('#ind-biblio-container .select-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('ind-step-config').style.opacity = '0.5';
  document.getElementById('ind-step-config').style.pointerEvents = 'none';
  document.getElementById('ind-btn-iniciar').disabled = true;
  document.getElementById('ind-btn-rapidito').disabled = true;
  refrescarHistoriales();
}

function formatearSegundos(seg) {
  const m = Math.floor(seg / 60).toString().padStart(2, '0');
  const s = (seg % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}