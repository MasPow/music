/**
 * app.js — Waveline Music Player
 *
 * SYSTÈME UNIFIÉ :
 *  - Au 1er lancement (DB vide) → charge depuis playlist.json, fetch les blobs, stocke en IndexedDB
 *  - Aux lancements suivants → charge depuis IndexedDB directement (rapide)
 *  - Import manuel toujours disponible pour ajouter de nouveaux sons
 *  - Écran mot de passe intégré proprement
 *  - Tous les boutons fonctionnent (play/pause/next/prev/shuffle/repeat/volume)
 *  - Playlists, recherche, menu contextuel, sidebar mobile
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// INDEXEDDB
// ═══════════════════════════════════════════════════════════════════════════════

var DB_NAME    = 'WavelineDB';
var DB_VERSION = 1;
var dbInstance = null;

function openDB() {
  return new Promise(function(resolve, reject) {
    if (dbInstance) return resolve(dbInstance);
    var req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = function(e) {
      var udb = e.target.result;
      if (!udb.objectStoreNames.contains('songs')) {
        var s = udb.createObjectStore('songs', { keyPath: 'id', autoIncrement: true });
        s.createIndex('title', 'title', { unique: false });
      }
      if (!udb.objectStoreNames.contains('playlists')) {
        udb.createObjectStore('playlists', { keyPath: 'id', autoIncrement: true });
      }
    };

    req.onsuccess = function(e) {
      dbInstance = e.target.result;
      dbInstance.onversionchange = function() { dbInstance.close(); dbInstance = null; };
      resolve(dbInstance);
    };
    req.onerror   = function(e) { reject(e.target.error); };
    req.onblocked = function()  { reject(new Error('IndexedDB blocked')); };
  });
}

function dbTx(storeName, mode, cb) {
  return openDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var tx    = db.transaction(storeName, mode);
      var store = tx.objectStore(storeName);
      var req;
      try { req = cb(store); } catch(e) { return reject(e); }
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

function dbAddSong(song) {
  var r = Object.assign({}, song); delete r.id;
  return dbTx('songs', 'readwrite', function(s) { return s.add(r); });
}
function dbPutSong(song) {
  return dbTx('songs', 'readwrite', function(s) { return s.put(song); });
}
function dbGetAllSongs() {
  return openDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var req = db.transaction('songs', 'readonly').objectStore('songs').getAll();
      req.onsuccess = function() { resolve(req.result); };
      req.onerror   = function() { reject(req.error); };
    });
  });
}
function dbGetSong(id) {
  return dbTx('songs', 'readonly', function(s) { return s.get(id); });
}
function dbDeleteSong(id) {
  return dbTx('songs', 'readwrite', function(s) { return s.delete(id); });
}
function dbAddPlaylist(pl) {
  var r = Object.assign({}, pl); delete r.id;
  return dbTx('playlists', 'readwrite', function(s) { return s.add(r); });
}
function dbGetAllPlaylists() {
  return openDB().then(function(db) {
    return new Promise(function(resolve, reject) {
      var req = db.transaction('playlists', 'readonly').objectStore('playlists').getAll();
      req.onsuccess = function() { resolve(req.result); };
      req.onerror   = function() { reject(req.error); };
    });
  });
}
function dbUpdatePlaylist(pl) {
  return dbTx('playlists', 'readwrite', function(s) { return s.put(pl); });
}
function dbDeletePlaylist(id) {
  return dbTx('playlists', 'readwrite', function(s) { return s.delete(id); });
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
// AUDIO — un seul objet, jamais recréé
// ═══════════════════════════════════════════════════════════════════════════════

var audio        = new Audio();
audio.preload    = 'auto';
var activeBlobUrl = null;

// ═══════════════════════════════════════════════════════════════════════════════
// MOT DE PASSE
// ═══════════════════════════════════════════════════════════════════════════════

var CORRECT_PASSWORD = '1608'; // Change ici

function initLockScreen() {
  var lockScreen = document.getElementById('lockScreen');
  var passInput  = document.getElementById('passwordInput');
  var unlockBtn  = document.getElementById('unlockBtn');
  var errorMsg   = document.getElementById('errorMsg');

  if (!lockScreen) return; // pas d'écran de verrou dans le HTML → on skip

  function tryUnlock() {
    if (passInput.value === CORRECT_PASSWORD) {
      lockScreen.style.display = 'none';
    } else {
      errorMsg.textContent = 'Mot de passe incorrect';
      passInput.value = '';
      passInput.focus();
    }
  }

  unlockBtn.addEventListener('click', tryUnlock);
  passInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') tryUnlock();
  });
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

  // Charger depuis IndexedDB
  try {
    await openDB();
    state.songs     = await dbGetAllSongs();
    state.playlists = await dbGetAllPlaylists();
  } catch(err) {
    console.error('DB init error:', err);
    showToast('⚠ Stockage indisponible pour cette session');
  }

  // ── Si la DB est vide → importer depuis playlist.json ──────────────────────
  // Les blobs sont fetchés depuis GitHub Pages et stockés en IndexedDB.
  // Au prochain rechargement, la DB sera déjà remplie → pas de re-fetch.
  if (state.songs.length === 0) {
    await loadFromJsonPlaylist();
  }

  renderSidebar();
  renderView();
  bindAudioEvents();
  bindEvents();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(function() {});
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CHARGEMENT DEPUIS playlist.json (seed au 1er lancement)
// ═══════════════════════════════════════════════════════════════════════════════

async function loadFromJsonPlaylist() {
  try {
    var res  = await fetch('playlist.json');
    if (!res.ok) throw new Error('playlist.json introuvable (' + res.status + ')');
    var data = await res.json();

    if (!data.library || data.library.length === 0) return;

    showToast('Chargement de la bibliothèque…');

    var loaded = 0;
    for (var i = 0; i < data.library.length; i++) {
      var song = data.library[i];
      try {
        // Fetch le fichier audio → blob → stocké en IndexedDB
        var audioRes = await fetch(song.url);
        if (!audioRes.ok) {
          console.warn('Audio introuvable:', song.url, audioRes.status);
          continue;
        }
        var blob  = await audioRes.blob();
        var newId = await dbAddSong({
          title:    song.title    || 'Sans titre',
          artist:   song.artist   || '',
          blob:     blob,
          duration: song.duration || null,
          coverUrl: null,
          addedAt:  Date.now()
        });
        state.songs.push({
          id:       newId,
          title:    song.title    || 'Sans titre',
          artist:   song.artist   || '',
          duration: song.duration || null,
          coverUrl: null,
          addedAt:  Date.now()
        });
        loaded++;
      } catch(e) {
        console.warn('Impossible de charger:', song.title, e.message);
      }
    }

    // Créer les playlists définies dans le JSON (Favorites, Workout, Chill…)
    if (data.playlists) {
      for (var plName in data.playlists) {
        var exists = state.playlists.find(function(p) { return p.name === plName; });
        if (!exists) {
          var newPlId = await dbAddPlaylist({ name: plName, songIds: [], createdAt: Date.now() });
          state.playlists.push({ id: newPlId, name: plName, songIds: [], createdAt: Date.now() });
        }
      }
    }

    if (loaded > 0) {
      showToast('✓ ' + loaded + ' son' + (loaded > 1 ? 's' : '') + ' chargé' + (loaded > 1 ? 's' : ''));
    } else {
      showToast('⚠ Aucun son chargé — vérifiez les chemins audio');
    }

  } catch(err) {
    console.error('Erreur playlist.json:', err);
    // Pas grave — l'utilisateur peut importer manuellement
  }
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
      e.stopPropagation();
      confirmDeletePlaylist(pl.id);
    });
    dom.playlistNav.appendChild(li);
  });
}

function renderView() {
  dom.searchSection.style.display = (state.currentView === 'search') ? 'block' : 'none';
  var songs = [];

  if (state.currentView === 'library') {
    dom.mainTitle.textContent   = 'Your Library';
    dom.importBtn.style.display = 'flex';
    songs = state.songs;

  } else if (state.currentView === 'search') {
    dom.mainTitle.textContent   = 'Search';
    dom.importBtn.style.display = 'none';
    var q = state.searchQuery.trim().toLowerCase();
    songs = q
      ? state.songs.filter(function(s) { return s.title.toLowerCase().includes(q); })
      : state.songs;

  } else if (state.currentView === 'playlist') {
    dom.importBtn.style.display = 'none';
    var pl = state.playlists.find(function(p) { return p.id === state.currentPlaylistId; });
    dom.mainTitle.textContent = pl ? escHtml(pl.name) : 'Playlist';
    songs = pl
      ? pl.songIds.map(function(id) { return state.songs.find(function(s) { return s.id === id; }); }).filter(Boolean)
      : [];
  }

  renderSongList(songs);
}

function renderSongList(songs) {
  dom.songList.innerHTML = '';

  if (songs.length === 0) {
    dom.emptyState.style.display = 'flex';
    return;
  }
  dom.emptyState.style.display = 'none';

  songs.forEach(function(song, idx) {
    var isActive = (song.id === state.currentSongId);
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
        '<div class="song-title">' + escHtml(song.title)                  + '</div>' +
        '<div class="song-meta">'  + escHtml(song.artist || 'Artiste inconnu') + '</div>' +
      '</div>' +
      '<div class="song-duration">' + (song.duration ? fmtDuration(song.duration) : '\u2014') + '</div>' +
      '<button class="song-menu-btn" aria-label="Plus d\'options">\u22ef</button>';

    li.addEventListener('click', function(e) {
      if (e.target.classList.contains('song-menu-btn')) return;
      playSongInContext(song.id, songs);
    });
    li.querySelector('.song-menu-btn').addEventListener('click', function(e) {
      e.stopPropagation();
      showContextMenu(e, song.id);
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
  var items = dom.songList.querySelectorAll('.song-item');
  items.forEach(function(li) {
    var isActive = (Number(li.dataset.id) === state.currentSongId);
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
// LECTURE
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
  if (activeBlobUrl) { URL.revokeObjectURL(activeBlobUrl); activeBlobUrl = null; }

  state.currentSongId = songId;
  state.isPlaying     = false;

  var stored;
  try {
    stored = await dbGetSong(songId);
  } catch(err) {
    console.error('DB read error:', err);
    showToast('⚠ Impossible de lire ce son');
    return;
  }

  if (!stored || !stored.blob) {
    showToast('⚠ Fichier audio introuvable en stockage');
    return;
  }

  activeBlobUrl = URL.createObjectURL(stored.blob);
  audio.src     = activeBlobUrl;

  try {
    await audio.play();
  } catch(err) {
    if (err.name === 'NotAllowedError') {
      showToast('▶ Cliquez sur Play (politique autoplay du navigateur)');
    } else {
      console.warn('audio.play() error:', err.name);
    }
  }

  renderPlayer();
  updatePlayingHighlight();
}

function togglePlay() {
  if (!state.currentSongId) {
    if (state.songs.length > 0) playSongInContext(state.songs[0].id, state.songs);
    return;
  }
  if (state.isPlaying) {
    audio.pause();
  } else {
    audio.play().catch(function(e) { console.warn('Resume error:', e.name); });
  }
}

function playNext() {
  if (state.queue.length === 0) return;
  if (state.shuffle) {
    var idx = state.queueIndex;
    if (state.queue.length > 1) {
      while (idx === state.queueIndex) idx = Math.floor(Math.random() * state.queue.length);
    }
    state.queueIndex = idx;
  } else {
    state.queueIndex = (state.queueIndex + 1) % state.queue.length;
  }
  playSong(state.queue[state.queueIndex]);
}

function playPrev() {
  if (state.queue.length === 0) return;
  if (audio.currentTime > 3) {
    audio.currentTime = 0;
    if (!state.isPlaying) audio.play().catch(function() {});
    return;
  }
  state.queueIndex = (state.queueIndex - 1 + state.queue.length) % state.queue.length;
  playSong(state.queue[state.queueIndex]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// ÉVÉNEMENTS AUDIO
// ═══════════════════════════════════════════════════════════════════════════════

function bindAudioEvents() {
  audio.addEventListener('play', function() {
    state.isPlaying = true;
    renderPlayer();
    updatePlayingHighlight();
  });
  audio.addEventListener('pause', function() {
    state.isPlaying = false;
    renderPlayer();
  });
  audio.addEventListener('ended', function() {
    state.isPlaying = false;
    if (state.repeat === 'one') {
      audio.currentTime = 0;
      audio.play().catch(function() {});
    } else if (state.repeat === 'all' || state.queueIndex < state.queue.length - 1) {
      playNext();
    } else {
      renderPlayer();
    }
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
      }).catch(function() {});
    }
  });
  audio.addEventListener('error', function() {
    console.error('Erreur audio:', audio.error);
    state.isPlaying = false;
    renderPlayer();
    showToast('⚠ Impossible de lire ce fichier audio');
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
// IMPORT MANUEL (bouton Import Music)
// ═══════════════════════════════════════════════════════════════════════════════

async function importFiles(files) {
  if (!files || files.length === 0) return;

  var TYPES = ['audio/mpeg','audio/ogg','audio/wav','audio/flac','audio/aac',
               'audio/mp4','audio/x-m4a','audio/webm','audio/x-wav','audio/opus'];
  var EXTS  = /\.(mp3|ogg|wav|flac|aac|m4a|webm|opus)$/i;

  var toImport = Array.from(files).filter(function(f) {
    return TYPES.indexOf(f.type) !== -1 || EXTS.test(f.name);
  });

  if (!toImport.length) {
    showToast('Aucun fichier audio compatible sélectionné');
    dom.fileInput.value = '';
    return;
  }

  showToast('Import de ' + toImport.length + ' fichier(s)\u2026');

  var imported = 0;
  for (var i = 0; i < toImport.length; i++) {
    var file  = toImport[i];
    var title = file.name.replace(/\.[^/.]+$/, '').replace(/[_\-]+/g, ' ').trim();
    try {
      var newId = await dbAddSong({ title: title, artist: '', blob: file, duration: null, coverUrl: null, addedAt: Date.now() });
      state.songs.push({ id: newId, title: title, artist: '', duration: null, coverUrl: null, addedAt: Date.now() });
      imported++;
    } catch(e) {
      console.error('Erreur import:', file.name, e);
    }
  }

  dom.fileInput.value = '';
  renderView();
  showToast(imported > 0
    ? '\u2713 ' + imported + ' son' + (imported > 1 ? 's' : '') + ' importé' + (imported > 1 ? 's' : '')
    : '\u26a0 Import échoué'
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MODAL PLAYLIST
// ═══════════════════════════════════════════════════════════════════════════════

var editingPlaylistId = null;

function openNewPlaylistModal() {
  editingPlaylistId = null;
  dom.playlistModalTitle.textContent = 'Nouvelle Playlist';
  dom.playlistNameInput.value        = '';
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
  hideModal();
  renderSidebar();
  renderView();
  showToast('Playlist "' + escHtml(name) + '" sauvegardée');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ACTIONS PLAYLIST
// ═══════════════════════════════════════════════════════════════════════════════

function openPlaylist(id) {
  state.currentView       = 'playlist';
  state.currentPlaylistId = id;
  updateNavActive('playlist');
  renderSidebar();
  renderView();
  closeSidebar();
}

async function confirmDeletePlaylist(id) {
  var pl = state.playlists.find(function(p) { return p.id === id; });
  if (!pl || !confirm('Supprimer la playlist "' + pl.name + '" ?')) return;
  await dbDeletePlaylist(id);
  state.playlists = state.playlists.filter(function(p) { return p.id !== id; });
  if (state.currentPlaylistId === id) { state.currentView = 'library'; state.currentPlaylistId = null; }
  renderSidebar();
  renderView();
  showToast('Playlist supprimée');
}

async function addToPlaylist(songId, playlistId) {
  hideContextMenu();
  var pl = state.playlists.find(function(p) { return p.id === playlistId; });
  if (!pl) return;
  if (pl.songIds.indexOf(songId) !== -1) { showToast('Déjà dans "' + pl.name + '"'); return; }
  pl.songIds.push(songId);
  await dbUpdatePlaylist(pl);
  showToast('Ajouté à "' + pl.name + '"');
}

async function removeFromCurrentPlaylist(songId) {
  hideContextMenu();
  var pl = state.playlists.find(function(p) { return p.id === state.currentPlaylistId; });
  if (!pl) return;
  pl.songIds = pl.songIds.filter(function(id) { return id !== songId; });
  await dbUpdatePlaylist(pl);
  renderView();
  showToast('Retiré de la playlist');
}

async function confirmDeleteSong(songId) {
  hideContextMenu();
  var song = state.songs.find(function(s) { return s.id === songId; });
  if (!song || !confirm('Supprimer "' + song.title + '" de la bibliothèque ?')) return;

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
    audio.pause();
    if (activeBlobUrl) { URL.revokeObjectURL(activeBlobUrl); activeBlobUrl = null; }
    state.currentSongId = null;
    state.isPlaying     = false;
    dom.playerBar.classList.remove('visible');
  }

  renderView();
  showToast('Son supprimé');
}

// ═══════════════════════════════════════════════════════════════════════════════
// MENU CONTEXTUEL
// ═══════════════════════════════════════════════════════════════════════════════

function showContextMenu(e, songId) {
  dom.contextMenu.innerHTML = '';

  if (state.playlists.length > 0) {
    var hdr = document.createElement('div');
    hdr.className = 'ctx-header';
    hdr.textContent = 'Ajouter à la playlist';
    dom.contextMenu.appendChild(hdr);

    state.playlists.forEach(function(pl) {
      var btn = document.createElement('button');
      btn.className   = 'ctx-item';
      btn.textContent = pl.name;
      btn.addEventListener('click', function() { addToPlaylist(songId, pl.id); });
      dom.contextMenu.appendChild(btn);
    });

    var sep = document.createElement('div');
    sep.className = 'ctx-sep';
    dom.contextMenu.appendChild(sep);
  }

  if (state.currentView === 'playlist' && state.currentPlaylistId !== null) {
    var rmBtn = document.createElement('button');
    rmBtn.className   = 'ctx-item ctx-danger';
    rmBtn.textContent = 'Retirer de la playlist';
    rmBtn.addEventListener('click', function() { removeFromCurrentPlaylist(songId); });
    dom.contextMenu.appendChild(rmBtn);
  }

  var delBtn = document.createElement('button');
  delBtn.className   = 'ctx-item ctx-danger';
  delBtn.textContent = 'Supprimer de la bibliothèque';
  delBtn.addEventListener('click', function() { confirmDeleteSong(songId); });
  dom.contextMenu.appendChild(delBtn);

  var mW = 210, mH = dom.contextMenu.childElementCount * 38 + 16;
  dom.contextMenu.style.left = Math.max(8, Math.min(e.clientX, window.innerWidth  - mW - 8)) + 'px';
  dom.contextMenu.style.top  = Math.max(8, Math.min(e.clientY, window.innerHeight - mH - 8)) + 'px';
  dom.contextMenu.classList.add('visible');
}

function hideContextMenu() { dom.contextMenu.classList.remove('visible'); }

// ═══════════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════════

function openLibrary() {
  state.currentView = 'library'; state.currentPlaylistId = null;
  updateNavActive('library'); renderView(); closeSidebar();
}

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

// ═══════════════════════════════════════════════════════════════════════════════
// SHUFFLE / REPEAT / VOLUME
// ═══════════════════════════════════════════════════════════════════════════════

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  dom.btnShuffle.classList.toggle('active', state.shuffle);
  showToast(state.shuffle ? 'Shuffle activé' : 'Shuffle désactivé');
}

function toggleRepeat() {
  var modes = ['none', 'all', 'one'];
  state.repeat = modes[(modes.indexOf(state.repeat) + 1) % modes.length];
  dom.btnRepeat.classList.toggle('active', state.repeat !== 'none');
  var old = dom.btnRepeat.querySelector('.repeat-one');
  if (old) old.remove();
  if (state.repeat === 'one') {
    var badge = document.createElement('span');
    badge.className = 'repeat-one'; badge.textContent = '1';
    dom.btnRepeat.appendChild(badge);
  }
  var labels = { none: 'Répétition off', all: 'Répéter tout', one: 'Répéter 1' };
  dom.btnRepeat.title = labels[state.repeat];
  showToast(labels[state.repeat]);
}

function setVolume(v) {
  audio.volume = Math.max(0, Math.min(1, parseFloat(v)));
  if (dom.volumeSlider) dom.volumeSlider.value = audio.volume;
}

// ═══════════════════════════════════════════════════════════════════════════════
// BINDING ÉVÉNEMENTS
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

  if (dom.emptyImportBtn) {
    dom.emptyImportBtn.addEventListener('click', function() { dom.fileInput.value = ''; dom.fileInput.click(); });
  }

  document.addEventListener('dragover', function(e) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', function(e) {
    e.preventDefault();
    if (e.dataTransfer) importFiles(e.dataTransfer.files);
  });

  dom.btnPlay.addEventListener('click',    togglePlay);
  dom.btnPrev.addEventListener('click',    playPrev);
  dom.btnNext.addEventListener('click',    playNext);
  dom.btnShuffle.addEventListener('click', toggleShuffle);
  dom.btnRepeat.addEventListener('click',  toggleRepeat);

  dom.progressBar.addEventListener('mousedown', function(e) { isSeeking = true; seekTo(e.clientX); });
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
    if (dom.contextMenu.classList.contains('visible') && !dom.contextMenu.contains(e.target))
      hideContextMenu();
  });

  document.addEventListener('keydown', function(e) {
    var tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key === 'Escape')  { hideContextMenu(); hideModal(); return; }
    if (e.code === 'Space')  { e.preventDefault(); togglePlay(); return; }
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

// Accepte "3:45" (string depuis JSON) ou un nombre de secondes
function fmtDuration(val) {
  if (!val) return '0:00';
  if (typeof val === 'string' && val.includes(':')) return val; // déjà formaté
  return fmtTime(parseFloat(val));
}

function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function getInitial(title) {
  return (String(title || '?').trim()[0] || '?').toUpperCase();
}

var toastTimer = null;
function showToast(msg) {
  var t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() { t.classList.remove('show'); }, 2800);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DÉMARRAGE
// ═══════════════════════════════════════════════════════════════════════════════

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
