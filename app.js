/**
 * app.js — Waveline Music Player
 *
 * FIX PRINCIPAL : FFmpegDemuxer / SRC_NOT_SUPPORTED
 * ─────────────────────────────────────────────────
 * Les fichiers téléchargés depuis YouTube sont souvent en WebM/Opus ou M4A
 * renommés en .mp3. Le navigateur refuse de les lire via audio.src direct
 * car il détecte le mauvais content-type depuis GitHub Pages.
 *
 * Solution : on fetch le fichier en blob, on détecte son vrai type via
 * les magic bytes (signature hexadécimale), on crée un objectURL avec
 * le bon MIME type → le navigateur peut lire n'importe quel format supporté.
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// INDEXEDDB
// ═══════════════════════════════════════════════════════════════════════════════

var DB_NAME    = 'WavelineDB';
var DB_VERSION = 3;
var dbInstance = null;

function openDB() {
  return new Promise(function(resolve, reject) {
    if (dbInstance) return resolve(dbInstance);
    var req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = function(e) {
      var udb = e.target.result;
      if (udb.objectStoreNames.contains('songs'))     udb.deleteObjectStore('songs');
      if (udb.objectStoreNames.contains('playlists')) udb.deleteObjectStore('playlists');
      var s = udb.createObjectStore('songs',     { keyPath: 'id', autoIncrement: true });
      s.createIndex('title', 'title', { unique: false });
      udb.createObjectStore('playlists', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = function(e) {
      dbInstance = e.target.result;
      dbInstance.onversionchange = function() { dbInstance.close(); dbInstance = null; };
      resolve(dbInstance);
    };
    req.onerror   = function(e) { reject(e.target.error); };
    req.onblocked = function()  { reject(new Error('IndexedDB bloquée')); };
  });
}

function dbTx(store, mode, cb) {
  return openDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx = db.transaction(store, mode);
      var st = tx.objectStore(store);
      var req;
      try { req = cb(st); } catch(e) { return reject(e); }
      if (req && typeof req.onsuccess !== 'undefined') {
        req.onsuccess = function() { resolve(req.result); };
        req.onerror   = function() { reject(req.error); };
      } else {
        tx.oncomplete = function() { resolve(); };
        tx.onerror    = function() { reject(tx.error); };
      }
    });
  });
}

function dbAddSong(song)      { var r = Object.assign({}, song); delete r.id; return dbTx('songs','readwrite',function(s){return s.add(r);}); }
function dbPutSong(song)      { return dbTx('songs','readwrite',function(s){return s.put(song);}); }
function dbGetSong(id)        { return dbTx('songs','readonly', function(s){return s.get(id);}); }
function dbDeleteSong(id)     { return dbTx('songs','readwrite',function(s){return s.delete(id);}); }
function dbGetAllSongs() {
  return openDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var req = db.transaction('songs','readonly').objectStore('songs').getAll();
      req.onsuccess = function() { resolve(req.result); };
      req.onerror   = function() { reject(req.error); };
    });
  });
}
function dbAddPlaylist(pl)    { var r = Object.assign({}, pl); delete r.id; return dbTx('playlists','readwrite',function(s){return s.add(r);}); }
function dbUpdatePlaylist(pl) { return dbTx('playlists','readwrite',function(s){return s.put(pl);}); }
function dbDeletePlaylist(id) { return dbTx('playlists','readwrite',function(s){return s.delete(id);}); }
function dbGetAllPlaylists() {
  return openDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var req = db.transaction('playlists','readonly').objectStore('playlists').getAll();
      req.onsuccess = function() { resolve(req.result); };
      req.onerror   = function() { reject(req.error); };
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// DÉTECTION DU FORMAT AUDIO PAR MAGIC BYTES
// Scanne les 36 premiers octets pour identifier le container.
// Couvre MP3, WebM, OGG, M4A, FLAC, WAV, AIFF, AAC, Opus.
// ═══════════════════════════════════════════════════════════════════════════════

function detectMimeType(buffer) {
  if (!buffer || buffer.byteLength < 4) return null;

  var bytes = new Uint8Array(buffer.slice(0, 36));
  var b0 = bytes[0], b1 = bytes[1], b2 = bytes[2], b3 = bytes[3];

  // WebM / Matroska  1a 45 df a3
  if (b0 === 0x1A && b1 === 0x45 && b2 === 0xDF && b3 === 0xA3) return 'audio/webm';

  // OGG (Opus, Vorbis)  4f 67 67 53  "OggS"
  if (b0 === 0x4F && b1 === 0x67 && b2 === 0x67 && b3 === 0x53) return 'audio/ogg';

  // MP3 avec tag ID3  49 44 33  "ID3"
  if (b0 === 0x49 && b1 === 0x44 && b2 === 0x33) return 'audio/mpeg';

  // MP3 sync word  FF Ex ou FF Fx
  if (b0 === 0xFF && (b1 & 0xE0) === 0xE0) return 'audio/mpeg';

  // AAC ADTS  FF F1 ou FF F9
  if (b0 === 0xFF && (b1 === 0xF1 || b1 === 0xF9)) return 'audio/aac';

  // FLAC  66 4c 61 43  "fLaC"
  if (b0 === 0x66 && b1 === 0x4C && b2 === 0x61 && b3 === 0x43) return 'audio/flac';

  // WAV  RIFF....WAVE  52 49 46 46
  if (b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46) return 'audio/wav';

  // AIFF  FORM....AIFF  46 4f 52 4d
  if (b0 === 0x46 && b1 === 0x4F && b2 === 0x52 && b3 === 0x4D) return 'audio/aiff';

  // M4A/MP4/AAC-LC : scanne les 32 premiers octets pour une box ISO (ftyp/moov/mdat/free/wide)
  // La box peut ne pas commencer à l'offset 0 si un atom "free" ou "wide" précède ftyp
  for (var off = 0; off <= 28; off += 4) {
    var t0 = bytes[off+4], t1 = bytes[off+5], t2 = bytes[off+6], t3 = bytes[off+7];
    if (!t0) break;
    // ftyp = 66 74 79 70
    if (t0===0x66 && t1===0x74 && t2===0x79 && t3===0x70) return 'audio/mp4';
    // moov = 6d 6f 6f 76
    if (t0===0x6D && t1===0x6F && t2===0x6F && t3===0x76) return 'audio/mp4';
    // mdat = 6d 64 61 74
    if (t0===0x6D && t1===0x64 && t2===0x61 && t3===0x74) return 'audio/mp4';
  }

  return null; // format inconnu
}

// Liste ordonnée de MIME types audio à essayer (du plus courant au moins courant)
var ALL_AUDIO_MIMES = [
  'audio/mpeg',   // MP3 — le plus courant
  'audio/webm',   // WebM/Opus — format par défaut de YouTube
  'audio/ogg',    // OGG/Vorbis ou OGG/Opus
  'audio/mp4',    // M4A/AAC
  'audio/aac',    // AAC raw (ADTS)
  'audio/flac',   // FLAC lossless
  'audio/wav',    // WAV PCM
  'audio/x-m4a'  // M4A variante Apple
];

/**
 * Essaie de lire l'ArrayBuffer avec chaque MIME type de la liste
 * en utilisant un ÉLÉMENT AUDIO ISOLÉ (pas le global audio) pour chaque test.
 * → Évite de déclencher les handlers globaux bindAudioEvents() pendant le test.
 * → Retourne { url, mime } dès qu'un format est reconnu, ou rejette.
 */
async function tryPlayWithMimes(arrayBuffer, mimeList) {
  // Référence factice pour tester canPlayType sans créer un vrai pipeline
  var probe = new Audio();

  for (var i = 0; i < mimeList.length; i++) {
    var mime = mimeList[i];

    // Ignore si le navigateur ne supporte clairement pas ce type
    if (probe.canPlayType(mime) === '') continue;

    var blob = new Blob([arrayBuffer], { type: mime });
    var url  = URL.createObjectURL(blob);

    // Élément DÉDIÉ pour chaque test — complètement isolé du player principal
    var testEl = new Audio();

    var works = await new Promise(function(resolve) {
      // Timeout de sécurité : si ni canplay ni error dans 4s → on abandonne ce MIME
      var timer = setTimeout(function() {
        testEl.src = '';
        resolve(false);
      }, 4000);

      testEl.addEventListener('canplay', function() {
        clearTimeout(timer);
        resolve(true);
      }, { once: true });

      testEl.addEventListener('error', function() {
        clearTimeout(timer);
        resolve(false);
      }, { once: true });

      testEl.preload = 'auto';
      testEl.src     = url;
      testEl.load();
    });

    // Nettoyage de l'élément de test
    testEl.src = '';

    if (works) {
      probe.src = ''; // cleanup probe
      return { url: url, mime: mime };
    }
    URL.revokeObjectURL(url);
  }

  probe.src = '';
  throw new Error('Aucun MIME ne marche — voir console pour les premiers octets');
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

var state = {
  songs:             [],
  playlists:         [],
  queue:             [],
  queueIndex:        -1,
  currentSongId:     null,
  isPlaying:         false,
  currentView:       'library',
  currentPlaylistId: null,
  searchQuery:       '',
  shuffle:           false,
  repeat:            'none'
};

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIO
// ═══════════════════════════════════════════════════════════════════════════════

var audio        = new Audio();
audio.preload    = 'auto';
var activeBlobUrl = null;

function revokeActive() {
  if (activeBlobUrl) { URL.revokeObjectURL(activeBlobUrl); activeBlobUrl = null; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MOT DE PASSE
// ═══════════════════════════════════════════════════════════════════════════════

var CORRECT_PASSWORD = '1608';

function initLockScreen() {
  var ls = document.getElementById('lockScreen');
  if (!ls) return;
  var pi  = document.getElementById('passwordInput');
  var btn = document.getElementById('unlockBtn');
  var err = document.getElementById('errorMsg');
  function tryUnlock() {
    if (pi.value === CORRECT_PASSWORD) {
      ls.style.display = 'none';
    } else {
      err.textContent = 'Mot de passe incorrect';
      pi.value = ''; pi.focus();
    }
  }
  btn.addEventListener('click', tryUnlock);
  pi.addEventListener('keydown', function(e) { if (e.key === 'Enter') tryUnlock(); });
}

// ═══════════════════════════════════════════════════════════════════════════════
// DOM
// ═══════════════════════════════════════════════════════════════════════════════

var dom = {};
function resolveDOM() {
  dom.sidebar          = document.getElementById('sidebar');
  dom.sidebarClose     = dom.sidebar ? dom.sidebar.querySelector('.sidebar-close') : null;
  dom.btnMenuOpen      = document.getElementById('btn-menu-toggle');
  dom.navLibrary       = document.getElementById('nav-library');
  dom.navSearch        = document.getElementById('nav-search');
  dom.playlistNav      = document.getElementById('playlist-nav');
  dom.btnNewPlaylist   = document.getElementById('btn-new-playlist');
  dom.mainTitle        = document.getElementById('main-title');
  dom.songList         = document.getElementById('song-list');
  dom.emptyState       = document.getElementById('empty-state');
  dom.importBtn        = document.getElementById('import-btn');
  dom.fileInput        = document.getElementById('file-input');
  dom.emptyImportBtn   = document.getElementById('empty-import-btn');
  dom.searchInput      = document.getElementById('search-input');
  dom.searchSection    = document.getElementById('search-section');
  dom.playerBar        = document.getElementById('player-bar');
  dom.playerTitle      = document.getElementById('player-title');
  dom.playerArtist     = document.getElementById('player-artist');
  dom.playerCover      = document.getElementById('player-cover');
  dom.btnPlay          = document.getElementById('btn-play');
  dom.btnPrev          = document.getElementById('btn-prev');
  dom.btnNext          = document.getElementById('btn-next');
  dom.btnShuffle       = document.getElementById('btn-shuffle');
  dom.btnRepeat        = document.getElementById('btn-repeat');
  dom.progressBar      = document.getElementById('progress-bar');
  dom.progressFill     = document.getElementById('progress-fill');
  dom.progressHandle   = document.getElementById('progress-handle');
  dom.timeElapsed      = document.getElementById('time-elapsed');
  dom.timeDuration     = document.getElementById('time-duration');
  dom.volumeSlider     = document.getElementById('volume-slider');
  dom.playlistModal      = document.getElementById('playlist-modal');
  dom.playlistModalTitle = document.getElementById('playlist-modal-title');
  dom.playlistNameInput  = document.getElementById('playlist-name-input');
  dom.btnSavePlaylist    = document.getElementById('btn-save-playlist');
  dom.btnCancelPlaylist  = document.getElementById('btn-cancel-playlist');
  dom.modalOverlay       = document.getElementById('modal-overlay');
  dom.contextMenu        = document.getElementById('context-menu');
}

// ═══════════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════════

async function init() {
  resolveDOM();
  initLockScreen();

  try {
    await openDB();
    state.songs     = await dbGetAllSongs();
    state.playlists = await dbGetAllPlaylists();
  } catch(err) {
    console.error('DB init error:', err);
    showToast('⚠ Stockage indisponible');
  }

  if (state.songs.length === 0) await loadFromJsonPlaylist();

  renderSidebar();
  renderView();
  bindAudioEvents();
  bindEvents();

  if ('serviceWorker' in navigator)
    navigator.serviceWorker.register('./service-worker.js').catch(function() {});
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHARGEMENT DEPUIS playlist.json
// On stocke uniquement les métadonnées (url, titre, artiste) — PAS le blob.
// La lecture fetche le blob en temps réel et détecte le vrai format.
// ═══════════════════════════════════════════════════════════════════════════════

async function loadFromJsonPlaylist() {
  try {
    var res = await fetch('playlist.json');
    if (!res.ok) throw new Error('playlist.json ' + res.status);
    var data = await res.json();
    if (!data.library || !data.library.length) return;

    showToast('Chargement…');
    var loaded = 0;

    for (var i = 0; i < data.library.length; i++) {
      var s = data.library[i];
      if (!s.url || !s.title) continue;
      try {
        var newId = await dbAddSong({
          title:    s.title,
          artist:   s.artist   || '',
          url:      s.url,
          blob:     null,
          duration: s.duration || null,
          coverUrl: null,
          source:   'json',
          addedAt:  Date.now()
        });
        state.songs.push({ id: newId, title: s.title, artist: s.artist || '', url: s.url,
                           duration: s.duration || null, coverUrl: null, source: 'json', addedAt: Date.now() });
        loaded++;
      } catch(e) { console.warn('Add song error:', s.title, e); }
    }

    if (loaded > 0) showToast('✓ ' + loaded + ' son' + (loaded > 1 ? 's' : '') + ' chargé' + (loaded > 1 ? 's' : ''));
    else showToast('⚠ Aucun son chargé');

  } catch(err) { console.error('playlist.json error:', err); }
}

// ═══════════════════════════════════════════════════════════════════════════════
// RENDER
// ═══════════════════════════════════════════════════════════════════════════════

function renderSidebar() {
  dom.playlistNav.innerHTML = '';
  state.playlists.forEach(function(pl) {
    var li = document.createElement('li');
    li.className  = 'playlist-item' + (state.currentPlaylistId === pl.id ? ' active' : '');
    li.dataset.id = pl.id;
    li.innerHTML =
      '<span class="playlist-icon">\u266b</span>' +
      '<span class="playlist-name">' + escHtml(pl.name) + '</span>' +
      '<button class="playlist-delete-btn" data-id="' + pl.id + '" title="Supprimer">\u2715</button>';
    li.addEventListener('click', function(e) {
      if (e.target.classList.contains('playlist-delete-btn')) return;
      openPlaylist(pl.id);
    });
    li.querySelector('.playlist-delete-btn').addEventListener('click', function(e) {
      e.stopPropagation(); confirmDeletePlaylist(pl.id);
    });
    dom.playlistNav.appendChild(li);
  });
}

function renderView() {
  dom.searchSection.style.display = state.currentView === 'search' ? 'block' : 'none';
  var songs = [];
  if (state.currentView === 'library') {
    dom.mainTitle.textContent = 'Your Library';
    dom.importBtn.style.display = 'flex';
    songs = state.songs;
  } else if (state.currentView === 'search') {
    dom.mainTitle.textContent = 'Search';
    dom.importBtn.style.display = 'none';
    var q = state.searchQuery.trim().toLowerCase();
    songs = q ? state.songs.filter(function(s) {
      return s.title.toLowerCase().includes(q) || (s.artist && s.artist.toLowerCase().includes(q));
    }) : state.songs;
  } else if (state.currentView === 'playlist') {
    dom.importBtn.style.display = 'none';
    var pl = state.playlists.find(function(p) { return p.id === state.currentPlaylistId; });
    dom.mainTitle.textContent = pl ? escHtml(pl.name) : 'Playlist';
    songs = pl ? pl.songIds.map(function(id) {
      return state.songs.find(function(s) { return s.id === id; });
    }).filter(Boolean) : [];
  }
  renderSongList(songs);
}

function renderSongList(songs) {
  dom.songList.innerHTML = '';
  if (songs.length === 0) { dom.emptyState.style.display = 'flex'; return; }
  dom.emptyState.style.display = 'none';

  songs.forEach(function(song, idx) {
    var isActive = song.id === state.currentSongId;
    var li = document.createElement('li');
    li.className  = 'song-item' + (isActive ? ' playing' : '');
    li.dataset.id = song.id;

    var coverHtml = song.coverUrl
      ? '<img src="' + escHtml(song.coverUrl) + '" alt="cover" class="song-cover-img">'
      : '<div class="song-cover-placeholder"><span>' + getInitial(song.title) + '</span></div>';

    var numHtml = isActive
      ? '<span class="eq-anim"><span></span><span></span><span></span></span>'
      : String(idx + 1);

    li.innerHTML =
      '<div class="song-number">'  + numHtml   + '</div>' +
      '<div class="song-cover">'   + coverHtml + '</div>' +
      '<div class="song-info">' +
        '<div class="song-title">' + escHtml(song.title)                       + '</div>' +
        '<div class="song-meta">'  + escHtml(song.artist || 'Artiste inconnu') + '</div>' +
      '</div>' +
      '<div class="song-duration">' + fmtDuration(song.duration) + '</div>' +
      '<button class="song-menu-btn" aria-label="Plus">\u22ef</button>';

    li.addEventListener('click', function(e) {
      if (e.target.classList.contains('song-menu-btn')) return;
      playSongInContext(song.id, songs);
    });
    li.querySelector('.song-menu-btn').addEventListener('click', function(e) {
      e.stopPropagation(); showContextMenu(e, song.id);
    });
    dom.songList.appendChild(li);
  });
}

function renderPlayer() {
  var song = state.songs.find(function(s) { return s.id === state.currentSongId; });
  if (!song) return;
  dom.playerTitle.textContent  = song.title;
  dom.playerArtist.textContent = song.artist || 'Artiste inconnu';
  dom.playerCover.innerHTML = song.coverUrl
    ? '<img src="' + escHtml(song.coverUrl) + '" alt="cover">'
    : '<div class="cover-placeholder">' + getInitial(song.title) + '</div>';
  dom.btnPlay.innerHTML = state.isPlaying
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  dom.playerBar.classList.add('visible');
}

function updatePlayingHighlight() {
  dom.songList.querySelectorAll('.song-item').forEach(function(li) {
    var isActive = Number(li.dataset.id) === state.currentSongId;
    li.classList.toggle('playing', isActive);
    var numEl = li.querySelector('.song-number');
    if (!numEl) return;
    if (isActive) {
      numEl.innerHTML = '<span class="eq-anim"><span></span><span></span><span></span></span>';
    } else {
      var all = Array.from(dom.songList.querySelectorAll('.song-item'));
      numEl.textContent = String(all.indexOf(li) + 1);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// LECTURE — fetch + détection MIME + objectURL
// ═══════════════════════════════════════════════════════════════════════════════

function playSongInContext(songId, contextSongs) {
  state.queue      = contextSongs.map(function(s) { return s.id; });
  state.queueIndex = state.queue.indexOf(songId);
  playSong(songId);
}

async function playSong(songId) {
  var song = state.songs.find(function(s) { return s.id === songId; });
  if (!song) return;

  audio.pause();
  revokeActive();

  state.currentSongId = songId;
  state.isPlaying     = false;
  renderPlayer();
  updatePlayingHighlight();

  if (song.source === 'json' && song.url) {
    // ── Son issu du JSON : fetch + diagnostic + essai MIME exhaustif ──────────
    showToast('Chargement…');
    var arrayBuffer;
    try {
      var fetchRes = await fetch(song.url);
      if (!fetchRes.ok) {
        showToast('⚠ Fichier 404 : ' + song.url);
        console.error('[DIAGNOSTIC] 404 sur:', song.url);
        return;
      }
      arrayBuffer = await fetchRes.arrayBuffer();
    } catch(err) {
      showToast('⚠ Erreur réseau : impossible de charger ' + song.title);
      console.error('[DIAGNOSTIC] Fetch échoué:', song.url, err.message);
      return;
    }

    // ── DIAGNOSTIC 1 : taille du fichier ──────────────────────────────────────
    var byteLen = arrayBuffer.byteLength;
    console.log('[DIAGNOSTIC]', song.title, '— taille:', byteLen, 'octets');

    if (byteLen === 0) {
      showToast('⚠ Fichier VIDE sur GitHub — re-uploadez ' + song.title);
      console.error('[DIAGNOSTIC] FICHIER VIDE:', song.url);
      return;
    }

    if (byteLen < 512) {
      // Fichier trop petit pour être un son — probablement un pointeur LFS ou du HTML
      var tiny = new TextDecoder('utf-8', {fatal: false}).decode(arrayBuffer.slice(0, 200));
      console.error('[DIAGNOSTIC] Fichier trop petit (' + byteLen + ' octets). Contenu:', tiny);
      if (tiny.indexOf('git-lfs') !== -1) {
        showToast('⚠ Git LFS détecté ! Uploadez les MP3 directement via GitHub web (glisser-déposer)');
      } else if (tiny.charAt(0) === '<') {
        showToast('⚠ GitHub renvoie du HTML — vérifiez le chemin : ' + song.url);
      } else {
        showToast('⚠ Fichier invalide (' + byteLen + ' octets) — re-uploadez ' + song.title);
      }
      return;
    }

    // ── DIAGNOSTIC 2 : premiers octets en hex ─────────────────────────────────
    var first8hex = Array.from(new Uint8Array(arrayBuffer.slice(0, 8)))
      .map(function(b) { return b.toString(16).padStart(2,'0'); }).join(' ');
    console.log('[DIAGNOSTIC]', song.title, '— premiers octets (hex):', first8hex);

    // ── DIAGNOSTIC 3 : fichier texte ? (LFS pointer ou page HTML servie) ──────
    var first4 = new Uint8Array(arrayBuffer.slice(0, 4));
    var isProbablyText = first4.every(function(b) {
      return (b >= 0x20 && b <= 0x7E) || b === 0x09 || b === 0x0A || b === 0x0D;
    });
    if (isProbablyText) {
      var preview = new TextDecoder('utf-8', {fatal: false}).decode(arrayBuffer.slice(0, 150));
      console.error("[DIAGNOSTIC] Contenu TEXTE recu au lieu audio:", preview);
      if (preview.indexOf('git-lfs') !== -1) {
        showToast('⚠ Git LFS — uploadez les MP3 via GitHub web sans git-lfs');
      } else if (preview.charAt(0) === '<') {
        showToast("⚠ Reçu du HTML — le fichier n'existe pas sur GitHub");
      } else {
        showToast('Fichier texte recu - re-uploadez: ' + song.title);
      }
      return;
    }

    // ── Détection MIME par magic bytes ────────────────────────────────────────
    var detectedMime = detectMimeType(arrayBuffer);
    console.log('[DIAGNOSTIC]', song.title, '→ MIME détecté:', detectedMime || 'inconnu (format non reconnu)');

    // Construit la liste : MIME détecté en premier, puis tous les autres en fallback
    var mimeList = detectedMime ? [detectedMime] : [];
    ALL_AUDIO_MIMES.forEach(function(m) {
      if (mimeList.indexOf(m) === -1) mimeList.push(m);
    });

    var result;
    try {
      result = await tryPlayWithMimes(arrayBuffer, mimeList);
    } catch(err) {
      console.error('[DIAGNOSTIC] Aucun MIME ne marche pour:', song.title, '— premiers octets:', first8hex);
      showToast('⚠ Format non supporté — vérifiez la console F12 pour diagnostiquer');
      return;
    }

    activeBlobUrl = result.url;
    console.log('[DIAGNOSTIC]', song.title, '→ lecture avec MIME:', result.mime, '✓');

    // CRITIQUE : assigner le bon src sur le player GLOBAL après le test MIME
    // (tryPlayWithMimes utilise des éléments isolés — audio global n'a pas le bon src)
    audio.src = activeBlobUrl;
    audio.load();

  } else {
    // ── Son importé localement : blob depuis IndexedDB ─────────────────────
    try {
      var stored = await dbGetSong(songId);
      if (!stored || !stored.blob) { showToast('⚠ Fichier introuvable en DB'); return; }
      activeBlobUrl = URL.createObjectURL(stored.blob);
      audio.src = activeBlobUrl;
      audio.load();
    } catch(err) {
      showToast('⚠ Erreur DB'); console.error(err); return;
    }
  }

  try {
    await audio.play();
  } catch(err) {
    if (err.name === 'NotAllowedError') {
      showToast('▶ Appuyez sur Play');
    } else if (err.name !== 'AbortError') {
      showToast('⚠ Lecture impossible : ' + err.name);
      console.error('play() error:', err.name, err.message);
    }
  }
}

function togglePlay() {
  if (!state.currentSongId) {
    if (state.songs.length > 0) playSongInContext(state.songs[0].id, state.songs);
    return;
  }
  if (state.isPlaying) {
    audio.pause();
  } else {
    audio.play().catch(function(e) { console.warn('Resume:', e.name); });
  }
}

function playNext() {
  if (!state.queue.length) return;
  if (state.shuffle) {
    var idx = state.queueIndex;
    if (state.queue.length > 1) while (idx === state.queueIndex) idx = Math.floor(Math.random() * state.queue.length);
    state.queueIndex = idx;
  } else {
    state.queueIndex = (state.queueIndex + 1) % state.queue.length;
  }
  playSong(state.queue[state.queueIndex]);
}

function playPrev() {
  if (!state.queue.length) return;
  if (audio.currentTime > 3) { audio.currentTime = 0; if (!state.isPlaying) audio.play().catch(function(){}); return; }
  state.queueIndex = (state.queueIndex - 1 + state.queue.length) % state.queue.length;
  playSong(state.queue[state.queueIndex]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVENTS AUDIO
// ═══════════════════════════════════════════════════════════════════════════════

function bindAudioEvents() {
  audio.addEventListener('play',  function() { state.isPlaying = true;  renderPlayer(); updatePlayingHighlight(); });
  audio.addEventListener('pause', function() { state.isPlaying = false; renderPlayer(); });
  audio.addEventListener('ended', function() {
    state.isPlaying = false;
    if (state.repeat === 'one') { audio.currentTime = 0; audio.play().catch(function(){}); }
    else if (state.repeat === 'all' || state.queueIndex < state.queue.length - 1) playNext();
    else renderPlayer();
  });
  audio.addEventListener('timeupdate', function() {
    if (!audio.duration || isNaN(audio.duration)) return;
    var pct = (audio.currentTime / audio.duration) * 100;
    dom.progressFill.style.width  = pct + '%';
    dom.progressHandle.style.left = pct + '%';
    dom.timeElapsed.textContent   = fmtTime(audio.currentTime);
  });
  audio.addEventListener('loadedmetadata', function() {
    if (isNaN(audio.duration)) return;
    dom.timeDuration.textContent = fmtTime(audio.duration);
    var song = state.songs.find(function(s) { return s.id === state.currentSongId; });
    if (song && !song.duration) {
      song.duration = audio.duration;
      dbGetSong(song.id).then(function(stored) {
        if (stored) { stored.duration = audio.duration; return dbPutSong(stored); }
      }).catch(function(){});
    }
  });
  audio.addEventListener('error', function() {
    if (!audio.error) return;
    var codes = {1:'ABORTED',2:'NETWORK',3:'DECODE',4:'SRC_NOT_SUPPORTED'};
    var detail = codes[audio.error.code] || audio.error.code;
    console.error('MediaError:', detail, audio.error.message || '');
    state.isPlaying = false;
    renderPlayer();
    showToast('⚠ Erreur lecture (' + detail + ')');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEEK
// ═══════════════════════════════════════════════════════════════════════════════

var isSeeking = false;
function seekTo(clientX) {
  if (!audio.duration || isNaN(audio.duration)) return;
  var rect = dom.progressBar.getBoundingClientRect();
  audio.currentTime = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * audio.duration;
}

// ═══════════════════════════════════════════════════════════════════════════════
// IMPORT MANUEL
// ═══════════════════════════════════════════════════════════════════════════════

async function importFiles(files) {
  if (!files || !files.length) return;
  var TYPES = ['audio/mpeg','audio/ogg','audio/wav','audio/flac','audio/aac','audio/mp4','audio/x-m4a','audio/webm','audio/x-wav','audio/opus'];
  var EXTS  = /\.(mp3|ogg|wav|flac|aac|m4a|webm|opus)$/i;
  var toImport = Array.from(files).filter(function(f) { return TYPES.indexOf(f.type) !== -1 || EXTS.test(f.name); });
  if (!toImport.length) { showToast('Aucun fichier audio compatible'); dom.fileInput.value = ''; return; }

  showToast('Import de ' + toImport.length + ' fichier(s)…');
  var imported = 0;
  for (var i = 0; i < toImport.length; i++) {
    var file  = toImport[i];
    var title = file.name.replace(/\.[^/.]+$/, '').replace(/[_\-]+/g, ' ').trim();
    try {
      var newId = await dbAddSong({ title: title, artist: '', url: null, blob: file,
                                    duration: null, coverUrl: null, source: 'local', addedAt: Date.now() });
      state.songs.push({ id: newId, title: title, artist: '', url: null, duration: null,
                         coverUrl: null, source: 'local', addedAt: Date.now() });
      imported++;
    } catch(e) { console.error('Import error:', file.name, e); }
  }
  dom.fileInput.value = '';
  renderView();
  showToast(imported > 0
    ? '\u2713 ' + imported + ' son' + (imported > 1 ? 's' : '') + ' importé' + (imported > 1 ? 's' : '')
    : '\u26a0 Import échoué');
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL PLAYLIST
// ═══════════════════════════════════════════════════════════════════════════════

var editingPlaylistId = null;

function openNewPlaylistModal() {
  editingPlaylistId = null;
  dom.playlistModalTitle.textContent = 'Nouvelle Playlist';
  dom.playlistNameInput.value = '';
  dom.playlistModal.classList.add('visible');
  dom.modalOverlay.classList.add('visible');
  setTimeout(function() { dom.playlistNameInput.focus(); }, 50);
}
function hideModal() {
  dom.playlistModal.classList.remove('visible');
  dom.modalOverlay.classList.remove('visible');
}
async function savePlaylist() {
  var name = dom.playlistNameInput.value.trim();
  if (!name) { dom.playlistNameInput.focus(); return; }
  if (editingPlaylistId !== null) {
    var pl = state.playlists.find(function(p) { return p.id === editingPlaylistId; });
    if (pl) { pl.name = name; await dbUpdatePlaylist(pl); }
  } else {
    var newId = await dbAddPlaylist({ name: name, songIds: [], createdAt: Date.now() });
    state.playlists.push({ id: newId, name: name, songIds: [], createdAt: Date.now() });
  }
  hideModal(); renderSidebar(); renderView();
  showToast('Playlist "' + escHtml(name) + '" sauvegardée');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTIONS PLAYLIST
// ═══════════════════════════════════════════════════════════════════════════════

function openPlaylist(id) {
  state.currentView = 'playlist'; state.currentPlaylistId = id;
  updateNavActive('playlist'); renderSidebar(); renderView(); closeSidebar();
}
async function confirmDeletePlaylist(id) {
  var pl = state.playlists.find(function(p) { return p.id === id; });
  if (!pl || !confirm('Supprimer "' + pl.name + '" ?')) return;
  await dbDeletePlaylist(id);
  state.playlists = state.playlists.filter(function(p) { return p.id !== id; });
  if (state.currentPlaylistId === id) { state.currentView = 'library'; state.currentPlaylistId = null; }
  renderSidebar(); renderView(); showToast('Playlist supprimée');
}
async function addToPlaylist(songId, playlistId) {
  hideContextMenu();
  var pl = state.playlists.find(function(p) { return p.id === playlistId; });
  if (!pl) return;
  if (pl.songIds.indexOf(songId) !== -1) { showToast('Déjà dans "' + pl.name + '"'); return; }
  pl.songIds.push(songId); await dbUpdatePlaylist(pl);
  showToast('Ajouté à "' + pl.name + '"');
}
async function removeFromCurrentPlaylist(songId) {
  hideContextMenu();
  var pl = state.playlists.find(function(p) { return p.id === state.currentPlaylistId; });
  if (!pl) return;
  pl.songIds = pl.songIds.filter(function(id) { return id !== songId; });
  await dbUpdatePlaylist(pl); renderView(); showToast('Retiré de la playlist');
}
async function confirmDeleteSong(songId) {
  hideContextMenu();
  var song = state.songs.find(function(s) { return s.id === songId; });
  if (!song || !confirm('Supprimer "' + song.title + '" ?')) return;
  await dbDeleteSong(songId);
  state.songs = state.songs.filter(function(s) { return s.id !== songId; });
  for (var i = 0; i < state.playlists.length; i++) {
    var pl = state.playlists[i];
    if (pl.songIds.indexOf(songId) !== -1) {
      pl.songIds = pl.songIds.filter(function(id) { return id !== songId; });
      await dbUpdatePlaylist(pl);
    }
  }
  if (state.currentSongId === songId) {
    audio.pause(); revokeActive();
    state.currentSongId = null; state.isPlaying = false;
    dom.playerBar.classList.remove('visible');
  }
  renderView(); showToast('Son supprimé');
}

// ═══════════════════════════════════════════════════════════════════════════════
// MENU CONTEXTUEL
// ═══════════════════════════════════════════════════════════════════════════════

function showContextMenu(e, songId) {
  dom.contextMenu.innerHTML = '';
  if (state.playlists.length > 0) {
    var hdr = document.createElement('div');
    hdr.className = 'ctx-header'; hdr.textContent = 'Ajouter à la playlist';
    dom.contextMenu.appendChild(hdr);
    state.playlists.forEach(function(pl) {
      var btn = document.createElement('button');
      btn.className = 'ctx-item'; btn.textContent = pl.name;
      btn.addEventListener('click', function() { addToPlaylist(songId, pl.id); });
      dom.contextMenu.appendChild(btn);
    });
    var sep = document.createElement('div'); sep.className = 'ctx-sep';
    dom.contextMenu.appendChild(sep);
  }
  if (state.currentView === 'playlist' && state.currentPlaylistId !== null) {
    var rmBtn = document.createElement('button');
    rmBtn.className = 'ctx-item ctx-danger'; rmBtn.textContent = 'Retirer de la playlist';
    rmBtn.addEventListener('click', function() { removeFromCurrentPlaylist(songId); });
    dom.contextMenu.appendChild(rmBtn);
  }
  var delBtn = document.createElement('button');
  delBtn.className = 'ctx-item ctx-danger'; delBtn.textContent = 'Supprimer de la bibliothèque';
  delBtn.addEventListener('click', function() { confirmDeleteSong(songId); });
  dom.contextMenu.appendChild(delBtn);
  var mW = 220, mH = dom.contextMenu.childElementCount * 38 + 16;
  dom.contextMenu.style.left = Math.max(8, Math.min(e.clientX, window.innerWidth  - mW - 8)) + 'px';
  dom.contextMenu.style.top  = Math.max(8, Math.min(e.clientY, window.innerHeight - mH - 8)) + 'px';
  dom.contextMenu.classList.add('visible');
}
function hideContextMenu() { dom.contextMenu.classList.remove('visible'); }

// ═══════════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════════

function openLibrary()    { state.currentView = 'library'; state.currentPlaylistId = null; updateNavActive('library'); renderView(); closeSidebar(); }
function openSearchView() {
  state.currentView = 'search'; state.currentPlaylistId = null;
  updateNavActive('search'); renderView();
  setTimeout(function() { if (dom.searchInput) dom.searchInput.focus(); }, 100);
  closeSidebar();
}
function updateNavActive(view) {
  dom.navLibrary.classList.toggle('active', view === 'library');
  dom.navSearch.classList.toggle('active',  view === 'search');
  dom.playlistNav.querySelectorAll('.playlist-item').forEach(function(el) {
    el.classList.toggle('active', view === 'playlist' && Number(el.dataset.id) === state.currentPlaylistId);
  });
}
function openSidebar()  { dom.sidebar.classList.add('open'); }
function closeSidebar() { dom.sidebar.classList.remove('open'); }

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  dom.btnShuffle.classList.toggle('active', state.shuffle);
  showToast(state.shuffle ? 'Shuffle activé' : 'Shuffle désactivé');
}
function toggleRepeat() {
  var modes = ['none','all','one'];
  state.repeat = modes[(modes.indexOf(state.repeat) + 1) % modes.length];
  dom.btnRepeat.classList.toggle('active', state.repeat !== 'none');
  var old = dom.btnRepeat.querySelector('.repeat-one'); if (old) old.remove();
  if (state.repeat === 'one') {
    var b = document.createElement('span'); b.className = 'repeat-one'; b.textContent = '1';
    dom.btnRepeat.appendChild(b);
  }
  var labels = { none:'Répétition off', all:'Répéter tout', one:'Répéter 1' };
  dom.btnRepeat.title = labels[state.repeat];
  showToast(labels[state.repeat]);
}
function setVolume(v) {
  audio.volume = Math.max(0, Math.min(1, parseFloat(v)));
  if (dom.volumeSlider) dom.volumeSlider.value = audio.volume;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BINDING
// ═══════════════════════════════════════════════════════════════════════════════

function bindEvents() {
  dom.navLibrary.addEventListener('click', openLibrary);
  dom.navSearch.addEventListener('click',  openSearchView);
  if (dom.sidebarClose) dom.sidebarClose.addEventListener('click', closeSidebar);
  if (dom.btnMenuOpen)  dom.btnMenuOpen.addEventListener('click',  openSidebar);
  document.addEventListener('click', function(e) {
    if (window.innerWidth < 768 && dom.sidebar.classList.contains('open') &&
        !dom.sidebar.contains(e.target) && e.target !== dom.btnMenuOpen) closeSidebar();
  });
  dom.importBtn.addEventListener('click', function() { dom.fileInput.value = ''; dom.fileInput.click(); });
  dom.fileInput.addEventListener('change', function(e) { importFiles(e.target.files); });
  if (dom.emptyImportBtn) dom.emptyImportBtn.addEventListener('click', function() { dom.fileInput.value = ''; dom.fileInput.click(); });
  document.addEventListener('dragover', function(e) { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
  document.addEventListener('drop', function(e) { e.preventDefault(); if (e.dataTransfer) importFiles(e.dataTransfer.files); });
  dom.btnPlay.addEventListener('click',    togglePlay);
  dom.btnPrev.addEventListener('click',    playPrev);
  dom.btnNext.addEventListener('click',    playNext);
  dom.btnShuffle.addEventListener('click', toggleShuffle);
  dom.btnRepeat.addEventListener('click',  toggleRepeat);
  dom.progressBar.addEventListener('mousedown',  function(e) { isSeeking = true; seekTo(e.clientX); });
  dom.progressBar.addEventListener('touchstart', function(e) { isSeeking = true; seekTo(e.touches[0].clientX); }, { passive: true });
  document.addEventListener('mousemove', function(e) { if (isSeeking) seekTo(e.clientX); });
  document.addEventListener('touchmove', function(e) { if (isSeeking) seekTo(e.touches[0].clientX); }, { passive: true });
  document.addEventListener('mouseup',  function() { isSeeking = false; });
  document.addEventListener('touchend', function() { isSeeking = false; });
  if (dom.volumeSlider) {
    dom.volumeSlider.value = audio.volume;
    dom.volumeSlider.addEventListener('input', function() { setVolume(dom.volumeSlider.value); });
  }
  dom.searchInput.addEventListener('input', function() { state.searchQuery = dom.searchInput.value; renderView(); });
  dom.btnNewPlaylist.addEventListener('click',    openNewPlaylistModal);
  dom.btnSavePlaylist.addEventListener('click',   savePlaylist);
  dom.btnCancelPlaylist.addEventListener('click', hideModal);
  dom.modalOverlay.addEventListener('click',      hideModal);
  dom.playlistNameInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter')  savePlaylist();
    if (e.key === 'Escape') hideModal();
  });
  document.addEventListener('click', function(e) {
    if (dom.contextMenu.classList.contains('visible') && !dom.contextMenu.contains(e.target)) hideContextMenu();
  });
  document.addEventListener('keydown', function(e) {
    var tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'Escape') { hideContextMenu(); hideModal(); return; }
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
    if (e.altKey && e.code === 'ArrowRight') { playNext(); return; }
    if (e.altKey && e.code === 'ArrowLeft')  { playPrev(); return; }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITAIRES
// ═══════════════════════════════════════════════════════════════════════════════

function fmtTime(sec) {
  if (!sec || isNaN(sec) || sec < 0) return '0:00';
  var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}
function fmtDuration(val) {
  if (!val) return '\u2014';
  if (typeof val === 'string' && val.indexOf(':') !== -1) return val;
  return fmtTime(parseFloat(val));
}
function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function getInitial(title) { return (String(title||'?').trim()[0]||'?').toUpperCase(); }

var toastTimer = null;
function showToast(msg) {
  var t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() { t.classList.remove('show'); }, 3000);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DÉMARRAGE
// ═══════════════════════════════════════════════════════════════════════════════

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
