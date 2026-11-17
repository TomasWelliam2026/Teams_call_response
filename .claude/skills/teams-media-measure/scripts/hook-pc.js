// Run in the receiver's Teams tab BEFORE the call connects: keeps every RTCPeerConnection in window.__pcs.
if (!window.__pcs) {
  window.__pcs = [];
  const O = window.RTCPeerConnection;
  window.RTCPeerConnection = function (...a) { const p = new O(...a); window.__pcs.push(p); return p; };
  window.RTCPeerConnection.prototype = O.prototype;
  Object.setPrototypeOf(window.RTCPeerConnection, O);
}
window.__pcs.length;
