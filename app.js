/**
 * app.js — Waveline Music Player
 * 
 * ROOT CAUSE FIX: Removed all ES module import/export syntax.
 * ES modules fail completely on file:// protocol (CORS error).
 * This file is now a standard script — all DB logic is inlined.
 * Load with: <script src="app.js"></script>  (NO type="module")
 *
 * All functionality verified:
 *  - Play / Pause / Next / Prev
 *  - File import (multiple files, drag & drop)
 *  - IndexedDB persistence across refreshes
 *  - Playlists (create, add songs, remove songs, delete)
 *  - Real-time search
 *  - Seekable progress bar
 *  - Shuffle / Repeat modes
 *  - Volume slider
 *  - Mobile sidebar
 *  - Context menu
 */

'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// DATABASE (was db.js — inlined to avoid ES module requirement)
// ═══════════════════════════════════════════════════════════════════════════════

const DB_NAME    = 'WavelineDB';
const DB_VERSION = 1;
let   dbInstance = null;

function openDB() {
  return new Promise(function(resolve, reject) {
    if (dbInstance) return resolve(dbInstance);

    var req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = function(e) {
      var upgradeDb = e.target.result;
      if (!upgradeDb.objectStoreNames.contains('songs')) {
        var songStore = upgradeDb.createObjectStore('songs', { keyPath: 'id', autoIncrement: true });
        songStore.createIndex('title', 'title', { unique: false });
      }
      if (!upgradeDb.objectStoreNames.contains('playlists')) {
        upgradeDb.createObjectStore('playlists', { keyPath: 'id', autoIncrement: true });
      }
    };

    req.onsuccess = function(e) {
      dbInstance = e.target.result;
      dbInstance.onversionchange = function() {
        dbInstance.close();
        dbInstance = null;
      };
      resolve(dbInstance);
    };

    req.onerror   = function(e) { reject(e.target.error); };
    req.onblocked = function()  { reject(new Error('IndexedDB blocked')); };
  });
}

function dbTx(storeName, mode, callback) {
  return openDB().then(function(database) {
    return new Promise(function(resolve, reject) {
      var transaction = database.transaction(storeName, mode);
      var store = transaction.objectStore(storeName);
      var request;
      try {
        request = callback(store);
      } catch(err) {
        return reject(err);
      }
      if (request && typeof request.onsuccess !== 'undefined') {
        request.onsuccess = function() { resolve(request.result); };
        request.onerror   = function() { reject(request.error); };
      } else {
        transaction.oncomplete = function() { resolve(); };
        transaction.onerror    = function() { reject(transaction.error); };
      }
    });
  });
}

// Songs
function dbAddSong(song) {
  var record = Object.assign({}, song);
  delete record.id;
  return dbTx('songs', 'readwrite', function(store) { return store.add(record); });
}
function dbPutSong(song) {
  return dbTx('songs', 'readwrite', function(store) { return store.put(song); });
}
function dbGetAllSongs() {
  return openDB().then(function(database) {
    return new Promise(function(resolve, reject) {
      var tx   = database.transaction('songs', 'readonly');
      var req  = tx.objectStore('songs').getAll();
      req.onsuccess = function() { resolve(req.result); };
      req.onerror   = function() { reject(req.error); };
    });
  });
}
function dbGetSong(id) {
  return dbTx('songs', 'readonly', function(store) { return store.get(id); });
}
function dbDeleteSong(id) {
  return dbTx('songs', 'readwrite', function(store) { return store.delete(id); });
}

// Playlists
function dbAddPlaylist(playlist) {
  var record = Object.assign({}, playlist);
  delete record.id;
  return dbTx('playlists', 'readwrite', function(store) { return store.add(record); });
}
function dbGetAllPlaylists() {
  return openDB().then(function(database) {
    return new Promise(function(resolve, reject) {
      var tx   = database.transaction('playlists', 'readonly');
      var req  = tx.objectStore('playlists').getAll();
      req.onsuccess = function() { resolve(req.result); };
      req.onerror   = function() { reject(req.error); };
    });
  });
}
function dbUpdatePlaylist(playlist) {
  return dbTx('playlists', 'readwrite', function(store) { return store.put(playlist); });
}
function dbDeletePlaylist(id) {
  return dbTx('playlists', 'readwrite', function(store) { return store.delete(id); });
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════════

var state = {
  songs:            [],
  playlists:        [],
  queue:            [],     // array of song ids in current playback context
  queueIndex:       -1,
  currentSongId:    null,
  isPlaying:        false,
  currentView:      'library',   // 'library' | 'search' | 'playlist'
  currentPlaylistId: null,
  searchQuery:      '',
  shuffle:          false,
  repeat:           'none'       // 'none' | 'all' | 'one'
};

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIO ENGINE — one global instance, never recreated
// ═══════════════════════════════════════════════════════════════════════════════

var audio        = new Audio();
audio.preload    = 'auto';
var activeBlobUrl = null;  // currently loaded object URL — revoked on song change

// ═══════════════════════════════════════════════════════════════════════════════
// DOM REFERENCES — resolved once after DOMContentLoaded
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

  dom.contextMenu = document.getElementById('context-menu');
}

// ═══════════════════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════════════════

async function init() {
  resolveDOM();

  try {
    await openDB();
    state.songs     = await dbGetAllSongs();
    state.playlists = await dbGetAllPlaylists();
  } catch (err) {
    console.error('DB init error:', err);
    showToast('⚠ Storage unavailable — data won\'t persist this session');
  }

  renderSidebar();
  renderView();
  bindAudioEvents();
  bindEvents();

  // Register service worker (silently fails on file://)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(function() {});
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
    li.innerHTML  =
      '<span class="playlist-icon">\u266b</span>' +
      '<span class="playlist-name">' + escHtml(pl.name) + '</span>' +
      '<button class="playlist-delete-btn" data-id="' + pl.id + '" title="Delete playlist">\u2715</button>';

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
  // Show/hide search bar
  dom.searchSection.style.display = (state.currentView === 'search') ? 'block' : 'none';

  var songs = [];

  if (state.currentView === 'library') {
    dom.mainTitle.textContent    = 'Your Library';
    dom.importBtn.style.display  = 'flex';
    songs = state.songs;

  } else if (state.currentView === 'search') {
    dom.mainTitle.textContent    = 'Search';
    dom.importBtn.style.display  = 'none';
    var q = state.searchQuery.trim().toLowerCase();
    songs = q ? state.songs.filter(function(s) {
      return s.title.toLowerCase().includes(q);
    }) : state.songs;

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
      '<div class="song-number">'  + numHtml + '</div>' +
      '<div class="song-cover">'   + coverHtml + '</div>' +
      '<div class="song-info">' +
        '<div class="song-title">' + escHtml(song.title) + '</div>' +
        '<div class="song-meta">'  + escHtml(song.artist || 'Unknown Artist') + '</div>' +
      '</div>' +
      '<div class="song-duration">' + (song.duration ? fmtTime(song.duration) : '\u2014') + '</div>' +
      '<button class="song-menu-btn" aria-label="More options">\u22ef</button>';

    // Click row → play
    li.addEventListener('click', function(e) {
      if (e.target.classList.contains('song-menu-btn')) return;
      playSongInContext(song.id, songs);
    });

    // Three-dot context menu
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
  dom.playerArtist.textContent = song.artist || 'Unknown Artist';

  if (song.coverUrl) {
    dom.playerCover.innerHTML = '<img src="' + escHtml(song.coverUrl) + '" alt="cover">';
  } else {
    dom.playerCover.innerHTML = '<div class="cover-placeholder">' + getInitial(song.title) + '</div>';
  }

  // Play / Pause icon
  dom.btnPlay.innerHTML = state.isPlaying
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

  dom.playerBar.classList.add('visible');
}

// Highlight the currently playing song row without rebuilding the whole list
function updatePlayingHighlight() {
  var items = dom.songList.querySelectorAll('.song-item');
  items.forEach(function(li) {
    var id = Number(li.dataset.id);
    var isActive = (id === state.currentSongId);
    li.classList.toggle('playing', isActive);
    var numEl = li.querySelector('.song-number');
    if (!numEl) return;
    if (isActive) {
      numEl.innerHTML = '<span class="eq-anim"><span></span><span></span><span></span></span>';
    } else {
      // Restore the row index number — find position in the list
      var allItems = Array.from(dom.songList.querySelectorAll('.song-item'));
      numEl.textContent = String(allItems.indexOf(li) + 1);
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYBACK
// ═══════════════════════════════════════════════════════════════════════════════

function playSongInContext(songId, contextSongs) {
  state.queue      = contextSongs.map(function(s) { return s.id; });
  state.queueIndex = state.queue.indexOf(songId);
  playSong(songId);
}

async function playSong(songId) {
  var song = state.songs.find(function(s) { return s.id === songId; });
  if (!song) return;

  // Stop current audio
  audio.pause();

  // Free the previous blob URL
  if (activeBlobUrl) {
    URL.revokeObjectURL(activeBlobUrl);
    activeBlobUrl = null;
  }

  state.currentSongId = songId;
  state.isPlaying     = false;

  // Fetch blob from IndexedDB
  var stored;
  try {
    stored = await dbGetSong(songId);
  } catch(err) {
    console.error('Could not fetch song from DB:', err);
    showToast('⚠ Could not load song from storage');
    return;
  }

  if (!stored || !stored.blob) {
    showToast('⚠ Audio file not found in storage');
    return;
  }

  // Create a fresh object URL and assign it
  activeBlobUrl = URL.createObjectURL(stored.blob);
  audio.src     = activeBlobUrl;

  // Attempt playback — handle autoplay policy gracefully
  try {
    await audio.play();
    // state.isPlaying is set by the 'play' event listener
  } catch(err) {
    if (err.name === 'NotAllowedError') {
      showToast('▶ Click Play to start (browser blocked autoplay)');
    } else {
      console.warn('audio.play() error:', err.name, err.message);
    }
  }

  renderPlayer();
  updatePlayingHighlight();
}

function togglePlay() {
  if (!state.currentSongId) {
    // Nothing queued — auto-start with first library song
    if (state.songs.length > 0) {
      playSongInContext(state.songs[0].id, state.songs);
    }
    return;
  }

  if (state.isPlaying) {
    audio.pause();
  } else {
    audio.play().catch(function(err) {
      console.warn('Resume play failed:', err.name);
    });
  }
  // UI update is handled by the 'play'/'pause' audio event listeners
}

function playNext() {
  if (state.queue.length === 0) return;

  if (state.shuffle) {
    var idx = state.queueIndex;
    if (state.queue.length > 1) {
      while (idx === state.queueIndex) {
        idx = Math.floor(Math.random() * state.queue.length);
      }
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
    // Restart current song
    audio.currentTime = 0;
    if (!state.isPlaying) {
      audio.play().catch(function() {});
    }
    return;
  }

  state.queueIndex = (state.queueIndex - 1 + state.queue.length) % state.queue.length;
  playSong(state.queue[state.queueIndex]);
}

// ═══════════════════════════════════════════════════════════════════════════════
// AUDIO EVENTS — bound once, never removed
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

    // Persist duration into DB so it shows in the list on next load
    var song = state.songs.find(function(s) { return s.id === state.currentSongId; });
    if (song && !song.duration) {
      song.duration = audio.duration;
      dbGetSong(song.id).then(function(stored) {
        if (stored) {
          stored.duration = audio.duration;
          return dbPutSong(stored);
        }
      }).catch(function(err) {
        console.warn('Could not persist duration:', err);
      });
    }
  });

  audio.addEventListener('error', function() {
    console.error('Audio element error:', audio.error);
    state.isPlaying = false;
    renderPlayer();
    showToast('⚠ Could not play this audio file');
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// PROGRESS BAR SEEKING
// ═══════════════════════════════════════════════════════════════════════════════

var isSeeking = false;

function seekTo(clientX) {
  if (!audio.duration || isNaN(audio.duration)) return;
  var rect = dom.progressBar.getBoundingClientRect();
  var pct  = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  audio.currentTime = pct * audio.duration;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILE IMPORT
// ═══════════════════════════════════════════════════════════════════════════════

async function importFiles(files) {
  if (!files || files.length === 0) return;

  var AUDIO_TYPES = [
    'audio/mpeg','audio/ogg','audio/wav','audio/flac',
    'audio/aac','audio/mp4','audio/x-m4a','audio/webm',
    'audio/x-wav','audio/x-flac','audio/opus'
  ];
  var AUDIO_EXTS = /\.(mp3|ogg|wav|flac|aac|m4a|webm|opus|flac)$/i;

  var toImport = Array.from(files).filter(function(f) {
    return AUDIO_TYPES.indexOf(f.type) !== -1 || AUDIO_EXTS.test(f.name);
  });

  if (!toImport.length) {
    showToast('No supported audio files selected');
    dom.fileInput.value = '';
    return;
  }

  showToast('Importing ' + toImport.length + ' file(s)\u2026');

  var imported = 0;
  for (var i = 0; i < toImport.length; i++) {
    var file  = toImport[i];
    var title = file.name
      .replace(/\.[^/.]+$/, '')
      .replace(/[_\-]+/g, ' ')
      .trim();

    try {
      var newId = await dbAddSong({
        title:    title,
        artist:   '',
        blob:     file,
        duration: null,
        coverUrl: null,
        addedAt:  Date.now()
      });

      // Push metadata-only record into state (blob lives only in DB)
      state.songs.push({
        id:       newId,
        title:    title,
        artist:   '',
        duration: null,
        coverUrl: null,
        addedAt:  Date.now()
      });

      imported++;
    } catch(err) {
      console.error('Import failed for', file.name, ':', err);
    }
  }

  dom.fileInput.value = '';  // allow re-selection of same files

  renderView();

  if (imported > 0) {
    showToast('\u2713 Imported ' + imported + (imported === 1 ? ' song' : ' songs'));
  } else {
    showToast('\u26a0 Import failed — see console');
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYLIST MODAL
// ═══════════════════════════════════════════════════════════════════════════════

var editingPlaylistId = null;

function openNewPlaylistModal() {
  editingPlaylistId = null;
  dom.playlistModalTitle.textContent = 'New Playlist';
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
    if (pl) {
      pl.name = name;
      await dbUpdatePlaylist(pl);
    }
  } else {
    var newId = await dbAddPlaylist({ name: name, songIds: [], createdAt: Date.now() });
    state.playlists.push({ id: newId, name: name, songIds: [], createdAt: Date.now() });
  }

  hideModal();
  renderSidebar();
  renderView();
  showToast('Playlist "' + escHtml(name) + '" saved');
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLAYLIST ACTIONS
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
  if (!pl) return;
  if (!confirm('Delete playlist "' + pl.name + '"?')) return;

  await dbDeletePlaylist(id);
  state.playlists = state.playlists.filter(function(p) { return p.id !== id; });

  if (state.currentPlaylistId === id) {
    state.currentView       = 'library';
    state.currentPlaylistId = null;
  }

  renderSidebar();
  renderView();
  showToast('Playlist deleted');
}

async function addToPlaylist(songId, playlistId) {
  hideContextMenu();
  var pl = state.playlists.find(function(p) { return p.id === playlistId; });
  if (!pl) return;

  if (pl.songIds.indexOf(songId) !== -1) {
    showToast('Already in "' + pl.name + '"');
    return;
  }
  pl.songIds.push(songId);
  await dbUpdatePlaylist(pl);
  showToast('Added to "' + pl.name + '"');
}

async function removeFromCurrentPlaylist(songId) {
  hideContextMenu();
  var pl = state.playlists.find(function(p) { return p.id === state.currentPlaylistId; });
  if (!pl) return;

  pl.songIds = pl.songIds.filter(function(id) { return id !== songId; });
  await dbUpdatePlaylist(pl);
  renderView();
  showToast('Removed from playlist');
}

async function confirmDeleteSong(songId) {
  hideContextMenu();
  var song = state.songs.find(function(s) { return s.id === songId; });
  if (!song) return;
  if (!confirm('Delete "' + song.title + '" from your library?')) return;

  await dbDeleteSong(songId);
  state.songs = state.songs.filter(function(s) { return s.id !== songId; });

  // Clean up from every playlist
  for (var i = 0; i < state.playlists.length; i++) {
    var pl = state.playlists[i];
    if (pl.songIds.indexOf(songId) !== -1) {
      pl.songIds = pl.songIds.filter(function(id) { return id !== songId; });
      await dbUpdatePlaylist(pl);
    }
  }

  // Stop if this was the playing song
  if (state.currentSongId === songId) {
    audio.pause();
    if (activeBlobUrl) { URL.revokeObjectURL(activeBlobUrl); activeBlobUrl = null; }
    state.currentSongId = null;
    state.isPlaying     = false;
    dom.playerBar.classList.remove('visible');
  }

  renderView();
  showToast('Song deleted');
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONTEXT MENU
// ═══════════════════════════════════════════════════════════════════════════════

function showContextMenu(e, songId) {
  dom.contextMenu.innerHTML = '';

  // Add to playlist options
  if (state.playlists.length > 0) {
    var hdr = document.createElement('div');
    hdr.className   = 'ctx-header';
    hdr.textContent = 'Add to playlist';
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

  // Remove from playlist (only when viewing a playlist)
  if (state.currentView === 'playlist' && state.currentPlaylistId !== null) {
    var rmBtn = document.createElement('button');
    rmBtn.className   = 'ctx-item ctx-danger';
    rmBtn.textContent = 'Remove from playlist';
    rmBtn.addEventListener('click', function() { removeFromCurrentPlaylist(songId); });
    dom.contextMenu.appendChild(rmBtn);
  }

  // Delete from library
  var delBtn = document.createElement('button');
  delBtn.className   = 'ctx-item ctx-danger';
  delBtn.textContent = 'Delete from library';
  delBtn.addEventListener('click', function() { confirmDeleteSong(songId); });
  dom.contextMenu.appendChild(delBtn);

  // Position: clamp to viewport
  var menuW = 190;
  var menuH = dom.contextMenu.childElementCount * 38 + 16;
  var x = Math.min(e.clientX, window.innerWidth  - menuW - 8);
  var y = Math.min(e.clientY, window.innerHeight - menuH - 8);
  dom.contextMenu.style.left = Math.max(8, x) + 'px';
  dom.contextMenu.style.top  = Math.max(8, y) + 'px';
  dom.contextMenu.classList.add('visible');
}

function hideContextMenu() {
  dom.contextMenu.classList.remove('visible');
}

// ═══════════════════════════════════════════════════════════════════════════════
// NAVIGATION
// ═══════════════════════════════════════════════════════════════════════════════

function openLibrary() {
  state.currentView       = 'library';
  state.currentPlaylistId = null;
  updateNavActive('library');
  renderView();
  closeSidebar();
}

function openSearchView() {
  state.currentView       = 'search';
  state.currentPlaylistId = null;
  updateNavActive('search');
  renderView();
  setTimeout(function() { dom.searchInput && dom.searchInput.focus(); }, 100);
  closeSidebar();
}

function updateNavActive(view) {
  dom.navLibrary.classList.toggle('active', view === 'library');
  dom.navSearch.classList.toggle('active',  view === 'search');
  var items = dom.playlistNav.querySelectorAll('.playlist-item');
  items.forEach(function(el) {
    el.classList.toggle('active',
      view === 'playlist' && Number(el.dataset.id) === state.currentPlaylistId
    );
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
  showToast(state.shuffle ? 'Shuffle on' : 'Shuffle off');
}

function toggleRepeat() {
  var modes = ['none', 'all', 'one'];
  state.repeat = modes[(modes.indexOf(state.repeat) + 1) % modes.length];

  dom.btnRepeat.classList.toggle('active', state.repeat !== 'none');

  // Remove old badge
  var old = dom.btnRepeat.querySelector('.repeat-one');
  if (old) old.remove();

  if (state.repeat === 'one') {
    var badge = document.createElement('span');
    badge.className   = 'repeat-one';
    badge.textContent = '1';
    dom.btnRepeat.appendChild(badge);
  }

  var labels = { none: 'Repeat off', all: 'Repeat all', one: 'Repeat one' };
  dom.btnRepeat.title = labels[state.repeat];
  showToast(labels[state.repeat]);
}

function setVolume(v) {
  audio.volume = Math.max(0, Math.min(1, parseFloat(v)));
  if (dom.volumeSlider) dom.volumeSlider.value = audio.volume;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT BINDING
// ═══════════════════════════════════════════════════════════════════════════════

function bindEvents() {

  // ── Navigation ──────────────────────────────────────────────────────────────
  dom.navLibrary.addEventListener('click', openLibrary);
  dom.navSearch.addEventListener('click',  openSearchView);

  // ── Mobile sidebar toggle ───────────────────────────────────────────────────
  if (dom.sidebarClose) {
    dom.sidebarClose.addEventListener('click', closeSidebar);
  }
  if (dom.btnMenuOpen) {
    dom.btnMenuOpen.addEventListener('click', openSidebar);
  }

  // Tap outside sidebar on mobile → close it
  document.addEventListener('click', function(e) {
    if (
      window.innerWidth < 768 &&
      dom.sidebar.classList.contains('open') &&
      !dom.sidebar.contains(e.target) &&
      e.target !== dom.btnMenuOpen
    ) {
      closeSidebar();
    }
  });

  // ── File import ─────────────────────────────────────────────────────────────
  dom.importBtn.addEventListener('click', function() {
    dom.fileInput.value = '';
    dom.fileInput.click();
  });

  dom.fileInput.addEventListener('change', function(e) {
    importFiles(e.target.files);
  });

  if (dom.emptyImportBtn) {
    dom.emptyImportBtn.addEventListener('click', function() {
      dom.fileInput.value = '';
      dom.fileInput.click();
    });
  }

  // Drag & drop anywhere
  document.addEventListener('dragover', function(e) {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  document.addEventListener('drop', function(e) {
    e.preventDefault();
    importFiles(e.dataTransfer ? e.dataTransfer.files : null);
  });

  // ── Player controls ─────────────────────────────────────────────────────────
  dom.btnPlay.addEventListener('click',    togglePlay);
  dom.btnPrev.addEventListener('click',    playPrev);
  dom.btnNext.addEventListener('click',    playNext);
  dom.btnShuffle.addEventListener('click', toggleShuffle);
  dom.btnRepeat.addEventListener('click',  toggleRepeat);

  // ── Progress bar ────────────────────────────────────────────────────────────
  dom.progressBar.addEventListener('mousedown', function(e) {
    isSeeking = true;
    seekTo(e.clientX);
  });
  dom.progressBar.addEventListener('touchstart', function(e) {
    isSeeking = true;
    seekTo(e.touches[0].clientX);
  }, { passive: true });
  document.addEventListener('mousemove', function(e) {
    if (isSeeking) seekTo(e.clientX);
  });
  document.addEventListener('touchmove', function(e) {
    if (isSeeking) seekTo(e.touches[0].clientX);
  }, { passive: true });
  document.addEventListener('mouseup',  function() { isSeeking = false; });
  document.addEventListener('touchend', function() { isSeeking = false; });

  // ── Volume ──────────────────────────────────────────────────────────────────
  if (dom.volumeSlider) {
    dom.volumeSlider.value = audio.volume;
    dom.volumeSlider.addEventListener('input', function() {
      setVolume(dom.volumeSlider.value);
    });
  }

  // ── Search ──────────────────────────────────────────────────────────────────
  dom.searchInput.addEventListener('input', function() {
    state.searchQuery = dom.searchInput.value;
    renderView();
  });

  // ── Playlist modal ──────────────────────────────────────────────────────────
  dom.btnNewPlaylist.addEventListener('click',    openNewPlaylistModal);
  dom.btnSavePlaylist.addEventListener('click',   savePlaylist);
  dom.btnCancelPlaylist.addEventListener('click', hideModal);
  dom.modalOverlay.addEventListener('click',      hideModal);
  dom.playlistNameInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter')  savePlaylist();
    if (e.key === 'Escape') hideModal();
  });

  // ── Context menu dismiss ────────────────────────────────────────────────────
  document.addEventListener('click', function(e) {
    if (dom.contextMenu.classList.contains('visible') &&
        !dom.contextMenu.contains(e.target)) {
      hideContextMenu();
    }
  });

  // ── Keyboard shortcuts ──────────────────────────────────────────────────────
  document.addEventListener('keydown', function(e) {
    var tag = document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (e.key === 'Escape') {
      hideContextMenu();
      hideModal();
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      togglePlay();
      return;
    }
    if (e.altKey && e.code === 'ArrowRight') { playNext(); return; }
    if (e.altKey && e.code === 'ArrowLeft')  { playPrev(); return; }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════

function fmtTime(sec) {
  if (sec == null || isNaN(sec) || sec < 0) return '0:00';
  var m = Math.floor(sec / 60);
  var s = Math.floor(sec % 60);
  return m + ':' + (s < 10 ? '0' : '') + s;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getInitial(title) {
  return (String(title || '?').trim()[0] || '?').toUpperCase();
}

var toastTimer = null;
function showToast(msg) {
  var t = document.getElementById('toast');
  if (!t) {
    t    = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function() { t.classList.remove('show'); }, 2800);
}

// ═══════════════════════════════════════════════════════════════════════════════
// BOOT — wait for DOM to be fully parsed
// ═══════════════════════════════════════════════════════════════════════════════

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  // Script was deferred or placed at end of body — DOM already ready
  init();
}

const correctPassword = "1608"; // CHANGE ÇA

const lockScreen = document.getElementById("lockScreen");
const input = document.getElementById("passwordInput");
const button = document.getElementById("unlockBtn");
const errorMsg = document.getElementById("errorMsg");

button.addEventListener("click", checkPassword);
input.addEventListener("keypress", function(e) {
  if (e.key === "Enter") checkPassword();
});

function checkPassword() {
  if (input.value === correctPassword) {
    lockScreen.style.display = "none";
  } else {
    errorMsg.textContent = "Mot de passe incorrect";
  }
}