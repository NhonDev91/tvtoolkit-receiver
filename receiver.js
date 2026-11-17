/*
 * TV Toolkit — Cast Web Receiver that shows the phone's screen over WebRTC.
 *
 * The phone (sender) captures its screen and is the WebRTC offerer. Signaling travels on a custom Cast
 * namespace (see README.md for the protocol). No STUN/TURN: phone and TV share a LAN, host candidates are
 * enough, and a TV-side mDNS candidate is learned by the phone as peer-reflexive during connectivity checks.
 *
 * Why WebRTC: a Cast receiver page is served over HTTPS, so it cannot fetch plain http:// data from the
 * phone on the LAN (mixed content). Only <video src> may, which forces HLS and several seconds of delay.
 * WebRTC media is not subject to that rule and plays with sub-second delay.
 *
 * Open with ?harness to drive it from test/harness.html (postMessage instead of Cast), ?debug for stats.
 */
'use strict';

const NAMESPACE = 'urn:x-cast:com.foxcode.tvtoolkit.mirror';
const PROTOCOL_VERSION = 1;
const CAF_URL = 'https://www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js';
const STATS_INTERVAL_MS = 1000;

const params = new URLSearchParams(location.search);
const harnessMode = params.has('harness');
const debugMode = params.has('debug');

const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const statusEl = document.getElementById('status');
const dotsEl = document.getElementById('dots');
const debugEl = document.getElementById('debug');

let transport = null;
let pc = null;
let peerId = null;
let pendingCandidates = [];
let statsTimer = null;

function showOverlay(text, busy) {
  statusEl.textContent = text;
  dotsEl.hidden = !busy;
  overlay.classList.remove('hidden');
}

function hideOverlay() {
  overlay.classList.add('hidden');
}

function log(...args) {
  console.log('[tvtoolkit]', ...args);
}

function send(to, msg) {
  if (!transport || !to) return;
  try {
    transport.send(to, msg);
  } catch (err) {
    log('send failed', msg.type, err);
  }
}

function closePeer(reason) {
  pendingCandidates = [];
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
  if (pc) {
    pc.ontrack = null;
    pc.onicecandidate = null;
    pc.onconnectionstatechange = null;
    pc.close();
    pc = null;
  }
  video.srcObject = null;
  peerId = null;
  if (reason) log('peer closed:', reason);
}

/** Keep the jitter buffer as small as the browser allows: this is a live screen, not a movie. */
function preferLowLatency(receiver) {
  try {
    if ('jitterBufferTarget' in receiver) receiver.jitterBufferTarget = 0;
  } catch (err) {
    log('jitterBufferTarget not supported', err);
  }
  try {
    receiver.playoutDelayHint = 0;
  } catch (err) {
    log('playoutDelayHint not supported', err);
  }
}

function attachTrack(event) {
  preferLowLatency(event.receiver);
  let stream = video.srcObject;
  if (!stream) {
    stream = event.streams && event.streams[0] ? event.streams[0] : new MediaStream();
    video.srcObject = stream;
  }
  if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);
  video.play().catch(() => {
    // Desktop browsers block unmuted autoplay without a gesture; Cast devices do not.
    video.muted = true;
    video.play().catch((err) => log('play failed', err));
  });
}

async function onOffer(from, sdp) {
  closePeer('new offer');
  peerId = from;
  const conn = new RTCPeerConnection({ iceServers: [] });
  pc = conn;
  showOverlay('Connecting…', true);

  conn.onicecandidate = (event) => {
    if (!event.candidate) return;
    send(from, {
      type: 'ICE',
      candidate: event.candidate.candidate,
      sdpMid: event.candidate.sdpMid,
      sdpMLineIndex: event.candidate.sdpMLineIndex,
    });
  };
  conn.ontrack = attachTrack;
  conn.onconnectionstatechange = () => {
    if (pc !== conn) return;
    const state = conn.connectionState;
    send(from, { type: 'STATE', state });
    if (state === 'connected') {
      // Back from "disconnected": the video never stopped, so no new 'playing' event will hide the overlay.
      if (video.srcObject && !video.paused) hideOverlay();
      if (debugMode && !statsTimer) startStats(conn);
    } else if (state === 'failed') {
      showOverlay('Connection lost. Start mirroring again on your phone.', false);
    } else if (state === 'disconnected') {
      showOverlay('Reconnecting…', true);
    }
  };

  await conn.setRemoteDescription({ type: 'offer', sdp });
  if (pc !== conn) return;
  const queued = pendingCandidates;
  pendingCandidates = [];
  for (const candidate of queued) await addCandidate(conn, candidate);
  const answer = await conn.createAnswer();
  await conn.setLocalDescription(answer);
  if (pc !== conn) return;
  send(from, { type: 'ANSWER', sdp: conn.localDescription.sdp });
}

async function addCandidate(conn, msg) {
  try {
    await conn.addIceCandidate({
      candidate: msg.candidate,
      sdpMid: msg.sdpMid,
      sdpMLineIndex: msg.sdpMLineIndex,
    });
  } catch (err) {
    log('bad candidate', msg.candidate, err);
  }
}

function onRemoteCandidate(from, msg) {
  if (from !== peerId) return;
  if (!pc || !pc.remoteDescription) {
    pendingCandidates.push(msg);
    return;
  }
  addCandidate(pc, msg);
}

function handle(from, msg) {
  if (typeof msg === 'string') {
    try {
      msg = JSON.parse(msg);
    } catch (err) {
      log('not JSON', msg);
      return;
    }
  }
  switch (msg && msg.type) {
    case 'HELLO':
      send(from, { type: 'READY', version: PROTOCOL_VERSION });
      break;
    case 'OFFER':
      onOffer(from, msg.sdp).catch((err) => {
        log('offer failed', err);
        send(from, { type: 'ERROR', message: String(err && err.message ? err.message : err) });
        showOverlay('Could not start the picture. Try again on your phone.', false);
      });
      break;
    case 'ICE':
      onRemoteCandidate(from, msg);
      break;
    case 'STOP':
      if (from === peerId) {
        closePeer('stopped by phone');
        showOverlay('Mirroring stopped.', false);
      }
      break;
    default:
      log('unknown message', msg);
  }
}

function startStats(conn) {
  debugEl.hidden = false;
  let last = null;
  statsTimer = setInterval(async () => {
    if (pc !== conn) return;
    const report = await conn.getStats();
    report.forEach((s) => {
      if (s.type !== 'inbound-rtp' || s.kind !== 'video') return;
      const kbps = last ? Math.round(((s.bytesReceived - last.bytesReceived) * 8) / (s.timestamp - last.timestamp)) : 0;
      const jitterMs = s.jitterBufferEmittedCount
        ? Math.round((s.jitterBufferDelay / s.jitterBufferEmittedCount) * 1000)
        : 0;
      debugEl.textContent =
        `${s.frameWidth || '?'}x${s.frameHeight || '?'}  ${Math.round(s.framesPerSecond || 0)} fps  ` +
        `${kbps} kbps\njitter buffer ${jitterMs} ms  lost ${s.packetsLost || 0}`;
      last = s;
    });
  }, STATS_INTERVAL_MS);
}

video.addEventListener('playing', hideOverlay);

function castTransport() {
  const context = cast.framework.CastReceiverContext.getInstance();
  context.addCustomMessageListener(NAMESPACE, (event) => handle(event.senderId, event.data));
  context.addEventListener(cast.framework.system.EventType.SENDER_CONNECTED, (event) => {
    send(event.senderId, { type: 'READY', version: PROTOCOL_VERSION });
  });
  context.addEventListener(cast.framework.system.EventType.SENDER_DISCONNECTED, (event) => {
    if (event.senderId === peerId) closePeer('phone disconnected');
    if (context.getSenders().length === 0) context.stop();
  });
  const options = new cast.framework.CastReceiverOptions();
  options.customNamespaces = { [NAMESPACE]: cast.framework.system.MessageType.JSON };
  // No media player: this page only shows a WebRTC stream. Skipping the players also avoids downloading
  // Shaka from ajax.googleapis.com, which some TVs fail to reach (seen on a Hisense: 6-60 s launches).
  options.skipPlayersLoad = true;
  // Without a media session the framework would close the app after a few idle minutes.
  options.disableIdleTimeout = true;
  options.statusText = 'TV Toolkit';
  context.start(options);
  return { send: (to, msg) => context.sendCustomMessage(NAMESPACE, to, msg) };
}

function harnessTransport() {
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || !event.data || !event.data.msg) return;
    handle(event.data.from || 'harness', event.data.msg);
  });
  return { send: (to, msg) => window.parent.postMessage({ to, msg }, '*') };
}

function loadCaf() {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CAF_URL;
    script.onload = resolve;
    script.onerror = () => reject(new Error('Cast receiver framework failed to load'));
    document.head.appendChild(script);
  });
}

if (harnessMode) {
  transport = harnessTransport();
  window.parent.postMessage({ to: 'harness', msg: { type: 'LOADED' } }, '*');
} else {
  loadCaf()
    .then(() => {
      transport = castTransport();
    })
    .catch((err) => {
      log(err);
      showOverlay('This page runs on a Chromecast or Google TV.', false);
    });
}
