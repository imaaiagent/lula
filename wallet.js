/* ══ LULA WALLET (shared) ═════════════════════════════════════
   One module, loaded by both /me and /deploy, so the wallet logic lives in
   exactly one place. LULA runs on Solana, and the only wallet it talks to is
   Phantom.

   Sign-in is a SIGNATURE, never a transaction — Phantom's signMessage proves
   the visitor controls the address and moves nothing, costs no fees. Top-ups
   are a separate, explicit SOL transfer the visitor confirms in Phantom.

   The exported object (window.JunctionWallet) keeps the same shape the pages
   already use — .connect(), .disconnect(), .sessionHeaders(), .restore(),
   .hasInjected(), .address, .session, .short, .onChange — so nothing else on
   the page has to change. (The internal name stays JunctionWallet on purpose;
   renaming it would break every caller.)                                  */

(function(){
  "use strict";

  // Live connection state, shared across the page.
  const J = window.JunctionWallet = {
    provider: null,      // the Phantom provider (window.solana)
    kind: null,          // 'phantom'
    address: null,       // base58, the signer's public key
    short: null,         // 0x-free short form for display
    session: null,       // server session token
    onChange: null,      // page sets this to re-render on connect/disconnect
  };

  /* ── find Phantom ──────────────────────────────────────────────
     Phantom injects a Solana provider at window.phantom.solana (preferred)
     and mirrors it at window.solana with isPhantom = true. We accept either,
     but only Phantom — no other wallet. */
  function getPhantom(){
    const p1 = window.phantom && window.phantom.solana;
    if(p1 && p1.isPhantom) return p1;
    const p2 = window.solana;
    if(p2 && p2.isPhantom) return p2;
    return null;
  }

  // base58 helpers — Phantom hands us Uint8Array signatures/keys, the server
  // wants base58 strings. Tiny self-contained encoder, no dependency.
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function b58encode(bytes){
    let digits = [0];
    for(let i = 0; i < bytes.length; i++){
      let carry = bytes[i];
      for(let j = 0; j < digits.length; j++){
        carry += digits[j] << 8;
        digits[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while(carry){ digits.push(carry % 58); carry = (carry / 58) | 0; }
    }
    // leading zero bytes -> leading '1's
    let str = '';
    for(let k = 0; k < bytes.length && bytes[k] === 0; k++) str += '1';
    for(let q = digits.length - 1; q >= 0; q--) str += B58[digits[q]];
    return str;
  }

  function shortOf(addr){
    return addr ? addr.slice(0, 4) + '…' + addr.slice(-4) : null;
  }

  /* ── sign-in flow ──────────────────────────────────────────────
     1. connect Phantom -> get the public key (base58)
     2. ask the server for a one-off challenge message
     3. Phantom signs those exact bytes
     4. server verifies the ed25519 signature and issues a session      */
  async function signIn(provider){
    // 1. connect
    const resp = await provider.connect();
    const address = (resp && resp.publicKey ? resp.publicKey : provider.publicKey).toString();

    // 2. challenge
    const cr = await fetch('/api/auth/challenge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: address }),
    });
    if(!cr.ok) throw new Error('could not start sign-in');
    const { message } = await cr.json();

    // 3. sign the message bytes
    const encoded = new TextEncoder().encode(message);
    const signed = await provider.signMessage(encoded, 'utf8');
    // Phantom returns { signature: Uint8Array } (or raw bytes on older builds)
    const sigBytes = signed && signed.signature ? signed.signature : signed;
    const signature = b58encode(sigBytes);

    // 4. verify
    const vr = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ wallet: address, nonce: nonceFrom(message), signature }),
    });
    const vd = await vr.json();
    if(!vr.ok) throw new Error(vd.error || 'sign-in failed');
    return vd;
  }

  // The challenge message embeds its own nonce on the last line ("Nonce: …").
  // Pull it back out so we can echo it to /verify.
  function nonceFrom(message){
    const m = /Nonce:\s*([A-Za-z0-9]+)/.exec(message || '');
    return m ? m[1] : '';
  }

  /* ── public API ─────────────────────────────────────────────── */

  J.connect = async function(){
    const provider = getPhantom();
    if(!provider) throw new Error('NO_PHANTOM');

    const vd = await signIn(provider);

    J.provider = provider;
    J.kind     = 'phantom';
    J.address  = vd.wallet;
    J.short    = vd.short;
    J.session  = vd.session;

    // reflect Phantom disconnecting/switching accounts
    try{
      provider.on && provider.on('disconnect', () => J.disconnect());
      provider.on && provider.on('accountChanged', () => J.disconnect());
    }catch(_){}

    if(J.onChange) J.onChange();
    return vd;
  };

  J.disconnect = async function(){
    try{
      if(J.session){
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: J.sessionHeaders(),
        });
      }
    }catch(_){}
    try{ if(J.provider && J.provider.disconnect) await J.provider.disconnect(); }catch(_){}
    J.provider = null; J.kind = null; J.address = null; J.short = null; J.session = null;
    if(J.onChange) J.onChange();
  };

  J.sessionHeaders = function(){
    return J.session ? { 'X-Junction-Session': J.session } : {};
  };

  // Restore a session from a prior visit (token kept in sessionStorage by the
  // page). Confirms it's still valid server-side before trusting it.
  J.restore = async function(){
    let saved = null;
    try{ saved = sessionStorage.getItem('jct_session'); }catch(_){}
    if(!saved) return false;
    J.session = saved;
    try{
      const r = await fetch('/api/auth/me', { headers: J.sessionHeaders() });
      if(r.ok){
        const d = await r.json();
        J.address = d.wallet; J.short = d.short;
        if(J.onChange) J.onChange();
        return true;
      }
    }catch(_){}
    J.session = null;
    return false;
  };

  // Is Phantom available to connect right now?
  J.hasInjected = function(){ return !!getPhantom(); };

  // For a "pay" action: hand back the connected Phantom provider so the page
  // can build and send a SOL transfer. Connects if needed.
  J.ensureProvider = async function(){
    if(J.provider) return J.provider;
    const provider = getPhantom();
    if(!provider) throw new Error('NO_PHANTOM');
    await provider.connect();
    J.provider = provider;
    return provider;
  };

})();
