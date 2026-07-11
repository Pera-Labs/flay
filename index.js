import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppRegistry, View, Text, Pressable, TextInput, Platform, Modal, Image, Animated, Easing,
  KeyboardAvoidingView, StatusBar, NativeEventEmitter, NativeModules, ScrollView, ActivityIndicator, AppState,
  Linking,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

function apiBase(endpoint) {
  // endpoint historically pointed at .../api/bug-reports — derive the API root from it.
  return String(endpoint || '').replace(/\/api\/bug-reports\/?$/, '');
}

async function getVoterId() {
  try {
    const KEY = '__flay_voter_id';
    let id = await AsyncStorage.getItem(KEY);
    if (!id) {
      id = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      await AsyncStorage.setItem(KEY, id);
    }
    return id;
  } catch { return 'v_anon'; }
}

function nativeCapture() {
  try {
    const mod = NativeModules && NativeModules.FlayBridge;
    if (mod && typeof mod.captureScreenshot === 'function') {
      return mod.captureScreenshot();
    }
  } catch {}
  return Promise.resolve(null);
}

let _flaySuppressed = false;
export function setFlaySuppressed(v) { _flaySuppressed = !!v; }
const FlayCtx = createContext({ enabled: false, open: () => {}, close: () => {} });

// Feedback SDK design tokens (v0.7.0) — iOS system palette, #0A84FF accent.
const T = {
  accent: '#0A84FF',
  bgLight: '#F2F2F7',
  cardWhite: '#FFFFFF',
  darkBg: '#1C1C1E',
  darkCard: '#2C2C2E',
  overlay: 'rgba(20,20,24,0.55)',
  overlaySolid: '#17171B',
  chipOff: 'rgba(255,255,255,0.16)',
  circleOff: 'rgba(255,255,255,0.18)',
  textMutedLight: 'rgba(60,60,67,0.6)',
  green: '#30B554',
  greenBg: '#E8F8EE',
  purple: '#AF52DE',
  purpleBg: 'rgba(175,82,222,0.14)',
  blueChipBg: 'rgba(10,132,255,0.12)',
  blueChipBorder: 'rgba(10,132,255,0.35)',
  greenChipBg: 'rgba(48,181,84,0.16)',
  greenChipText: '#1F8A3D',
  orange: '#FF9F0A',
  segTrack: 'rgba(118,118,128,0.12)',
  // dark admin variants
  newBg: 'rgba(10,132,255,0.22)', newText: '#64B5FF',
  progBg: 'rgba(255,159,10,0.22)', progText: '#FFB84D',
  fixedBg: 'rgba(48,181,84,0.22)', fixedText: '#5ED47F',
};

let CONFIG = {
  appName: 'Friday Cockpit',
  appId: 'app',
  version: '1.0.0',
  endpoint: 'https://api.wishly.tools/api/bug-reports',
};

const FLAY_QUEUE = [];
const FLAY_QUEUE_MAX = 10;

function postBugOnce(payload) {
  return fetch(payload.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId: payload.appId,
      version: payload.version,
      note: payload.note,
      screenshot: payload.screenshot,
      source: 'friday-cockpit',
      ts: payload.ts || new Date().toISOString(),
    }),
  }).then(r => {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  });
}

function postBug(payload) {
  const stamped = { ...payload, ts: payload.ts || new Date().toISOString() };
  return postBugOnce(stamped)
    .then(res => (res && res.ok ? res : Promise.reject(new Error('server-reject'))))
    .catch((e) => {
      if (FLAY_QUEUE.length < FLAY_QUEUE_MAX) FLAY_QUEUE.push(stamped);
      return { ok: false, error: String(e && e.message || e), queued: true };
    });
}

async function flayDrainQueue() {
  if (!FLAY_QUEUE.length) return 0;
  const batch = FLAY_QUEUE.splice(0, FLAY_QUEUE.length);
  let sent = 0;
  for (const item of batch) {
    try { const r = await postBugOnce(item); if (r && r.ok) sent++; else FLAY_QUEUE.push(item); }
    catch { FLAY_QUEUE.push(item); }
  }
  return sent;
}

function fetchBugs({ endpoint, appId, adminToken }) {
  const url = `${apiBase(endpoint)}/api/bug-reports?appId=${encodeURIComponent(appId)}`;
  return fetch(url, { headers: { 'x-admin-token': adminToken || '' } })
    .then(r => r.json()).catch((e) => ({ ok: false, error: String(e) }));
}

function bugShotUrl(endpoint, path) {
  if (!path) return null;
  return `${apiBase(endpoint)}/api/bug-shots/${encodeURIComponent(path)}`;
}

function updateBugStatus({ endpoint, id, adminToken, status }) {
  return fetch(`${apiBase(endpoint)}/api/bug-reports/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken || '' },
    body: JSON.stringify({ status }),
  }).then(r => r.json()).catch((e) => ({ ok: false, error: String(e) }));
}

function fetchFeatures({ endpoint, appId, voterId }) {
  const url = `${apiBase(endpoint)}/api/feature-requests?appId=${encodeURIComponent(appId)}&voterId=${encodeURIComponent(voterId || '')}`;
  return fetch(url).then(r => r.json()).catch((e) => ({ ok: false, error: String(e) }));
}

function submitFeature({ endpoint, appId, title, description, authorId }) {
  return fetch(`${apiBase(endpoint)}/api/feature-requests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId, title, description, authorId }),
  }).then(r => r.json()).catch((e) => ({ ok: false, error: String(e) }));
}

function toggleFeatureVote({ endpoint, id, voterId, voted }) {
  return fetch(`${apiBase(endpoint)}/api/feature-requests/${id}/vote`, {
    method: voted ? 'DELETE' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voterId }),
  }).then(r => r.json()).catch((e) => ({ ok: false, error: String(e) }));
}

let _setVisibleExt = null;
let _setSnapExt = null;
function nativePresent() { if (_setVisibleExt) _setVisibleExt(true); }
function nativeDismiss() { if (_setVisibleExt) _setVisibleExt(false); }

export function FlayProvider({ config = {}, children }) {
  CONFIG = { ...CONFIG, ...config };
  const rootRef = useRef(null);
  const [visible, setVisible] = useState(false);
  const [snapUri, setSnapUri] = useState(null);
  useEffect(() => {
    _setVisibleExt = setVisible;
    _setSnapExt = setSnapUri;
    return () => { _setVisibleExt = null; _setSnapExt = null; };
  }, []);

  const captureNow = useCallback(async () => {
    try {
      const dataUri = await nativeCapture();
      if (typeof dataUri !== 'string' || !dataUri.startsWith('data:')) return null;
      return dataUri;
    } catch { return null; }
  }, []);

  const handleOpen = useCallback(async () => {
    if (_flaySuppressed) return;
    const uri = await captureNow();
    setSnapUri(uri);
    nativePresent();
  }, [captureNow]);

  const handleClose = useCallback(() => { nativeDismiss(); }, []);

  useEffect(() => {
    const mod = NativeModules && NativeModules.FlayBridge;
    if (!mod) return;
    const emitter = new NativeEventEmitter(mod);
    const sub = emitter.addListener('FlayOpen', () => { if (_flaySuppressed) return; handleOpen(); });
    return () => { try { sub && sub.remove(); } catch {} };
  }, [handleOpen]);

  useEffect(() => {
    const onChange = (state) => { if (state === 'active') flayDrainQueue().catch(() => {}); };
    const sub = AppState.addEventListener('change', onChange);
    return () => { try { sub && sub.remove(); } catch {} };
  }, []);

  const ctx = useMemo(() => ({
    enabled: true,
    open: handleOpen,
    close: handleClose,
  }), [handleOpen, handleClose]);

  return (
    <FlayCtx.Provider value={ctx}>
      <View ref={rootRef} collapsable={false} style={{ flex: 1 }}>
        {children}
      </View>
      <Modal visible={visible} animationType="fade" presentationStyle="overFullScreen" transparent={false} onRequestClose={() => setVisible(false)}>
        <FlayOverlay snapUri={snapUri} />
      </Modal>
    </FlayCtx.Provider>
  );
}

export function useFlay() {
  return useContext(FlayCtx);
}

function timeAgo(iso) {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 60) return `${Math.floor(d)}s`;
  if (d < 3600) return `${Math.floor(d / 60)}d`;
  if (d < 86400) return `${Math.floor(d / 3600)}sa`;
  return `${Math.floor(d / 86400)}g`;
}

const CATEGORIES = ['Bug', 'Suggestion', 'Other'];

function statusBucket(status) {
  const s = String(status || 'open').toLowerCase();
  if (s === 'planned' || s === 'in_progress') return 'Planned';
  if (s === 'shipped' || s === 'done' || s === 'closed') return 'Done';
  return 'Open';
}

function tagChipColors(bucket) {
  if (bucket === 'Planned') return { bg: T.purpleBg, text: T.purple };
  if (bucket === 'Done') return { bg: T.greenChipBg, text: T.greenChipText };
  return { bg: T.blueChipBg, text: T.accent };
}

function adminStatusColors(status) {
  const s = String(status || 'new').toLowerCase();
  if (s === 'in_progress' || s === 'in progress') return { bg: T.progBg, text: T.progText, label: 'In progress' };
  if (s === 'fixed' || s === 'resolved' || s === 'closed') return { bg: T.fixedBg, text: T.fixedText, label: 'Fixed' };
  return { bg: T.newBg, text: T.newText, label: 'New' };
}

function severityDotColor(sev) {
  const s = String(sev || '').toLowerCase();
  if (s === 'high' || s === 'critical') return '#FF453A';
  if (s === 'low') return '#8E8E93';
  if (s === 'medium') return T.orange;
  return null;
}

function FlayOverlay({ snapUri }) {
  const [screen, setScreen] = useState('home');
  const [note, setNote] = useState('');
  const [category, setCategory] = useState('Bug');
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState(null);
  const [pulling, setPulling] = useState(false);
  const showAbInfo = async () => {
    try {
      const fn = CONFIG.abInfo;
      const info = typeof fn === 'function' ? await fn() : null;
      setToast(String(info || 'AB bilgisi yok'));
    } catch (e) {
      setToast('AB hata: ' + String((e && e.message) || e).slice(0, 80));
    }
    setTimeout(() => setToast(null), 3500);
  };
  const pullUpdate = async () => {
    if (pulling) return;
    setPulling(true);
    try {
      const Updates = require('expo-updates');
      if (!Updates || !Updates.checkForUpdateAsync) {
        setToast('expo-updates yüklü değil');
        setTimeout(() => setToast(null), 2200);
        setPulling(false);
        return;
      }
      const r = await Updates.checkForUpdateAsync();
      if (r && r.isAvailable) {
        try { await Updates.fetchUpdateAsync(); } catch (e) {}
        setToast('Güncelleme indirildi, yeniden başlatılıyor…');
        setTimeout(async () => {
          try { await Updates.reloadAsync(); } catch (e) { setPulling(false); setToast(null); }
        }, 800);
      } else {
        setToast('Zaten en güncel sürümdesin');
        setTimeout(() => { setToast(null); setPulling(false); }, 2200);
      }
    } catch (e) {
      setToast('Hata: ' + String((e && e.message) || e).slice(0, 80));
      setTimeout(() => { setToast(null); setPulling(false); }, 3000);
    }
  };
  const [bugs, setBugs] = useState(null);
  const [loadingBugs, setLoadingBugs] = useState(false);
  const [selectedBug, setSelectedBug] = useState(null);
  const [fullscreenShot, setFullscreenShot] = useState(false);
  const [savingStatus, setSavingStatus] = useState(false);
  const [adminToken, setAdminToken] = useState(null);
  const [tokenInput, setTokenInput] = useState('');
  const [pair, setPair] = useState(null);
  const [features, setFeatures] = useState(null);
  const [loadingFeatures, setLoadingFeatures] = useState(false);
  const [featTitle, setFeatTitle] = useState('');
  const [showAddFeature, setShowAddFeature] = useState(false);
  const [featFilter, setFeatFilter] = useState('Open');
  const [voterId, setVoterId] = useState(null);
  const { appName, appId, version, endpoint } = CONFIG;

  useEffect(() => {
    AsyncStorage.getItem('__flay_admin_token').then(setAdminToken).catch(() => {});
    getVoterId().then(setVoterId);
  }, []);

  const saveToken = useCallback(async () => {
    const t = tokenInput.trim();
    if (!t) return;
    await AsyncStorage.setItem('__flay_admin_token', t);
    setAdminToken(t);
    setTokenInput('');
  }, [tokenInput]);

  const startPairing = useCallback(async () => {
    try {
      const r = await fetch(apiBase(endpoint) + '/api/pair/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ appId }),
      }).then((x) => x.json());
      if (r && r.code) setPair(r);
    } catch (e) {}
  }, [endpoint, appId]);

  const scale = useRef(new Animated.Value(1.35)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 8, tension: 50 }),
      Animated.timing(opacity, { toValue: 1, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
  }, [scale, opacity]);

  const close = useCallback(() => { nativeDismiss(); }, []);

  const loadBugs = useCallback(async () => {
    if (!adminToken) return;
    setLoadingBugs(true);
    const res = await fetchBugs({ endpoint, appId, adminToken });
    setLoadingBugs(false);
    setBugs((res && res.bugs) || []);
  }, [endpoint, appId, adminToken]);

  // poll pairing status every 2s until the owner approves on Wishly
  useEffect(() => {
    if (screen !== 'bugs' || adminToken || !pair || !pair.code) return;
    let alive = true;
    const id = setInterval(async () => {
      try {
        const r = await fetch(apiBase(endpoint) + '/api/pair/' + pair.code).then((x) => x.json());
        if (!alive) return;
        if (r && r.status === 'approved' && r.apiKey) {
          await AsyncStorage.setItem('__flay_admin_token', r.apiKey);
          setAdminToken(r.apiKey); setPair(null);
        } else if (r && (r.status === 'expired' || r.status === 'unknown')) {
          setPair(null); startPairing();
        }
      } catch (e) {}
    }, 2000);
    return () => { alive = false; clearInterval(id); };
  }, [screen, adminToken, pair, endpoint, startPairing]);

  // once a token arrives (via approval or paste), load the bug list
  useEffect(() => { if (adminToken && screen === 'bugs') loadBugs(); }, [adminToken]);

  const openBugs = useCallback(() => {
    setScreen('bugs');
    if (adminToken) loadBugs(); else startPairing();
  }, [loadBugs, adminToken, startPairing]);

  const openBugDetail = useCallback((b) => {
    setSelectedBug(b);
    setScreen('bugDetail');
  }, []);

  const setBugStatus = useCallback(async (b, status) => {
    if (!adminToken || !b) return;
    setSavingStatus(true);
    const res = await updateBugStatus({ endpoint, id: b.id, adminToken, status });
    setSavingStatus(false);
    if (res && res.ok !== false) {
      const patched = { ...b, status };
      setSelectedBug(patched);
      setBugs((cur) => (cur || []).map((x) => (x.id === b.id ? patched : x)));
    }
  }, [endpoint, adminToken]);

  const loadFeatures = useCallback(async () => {
    setLoadingFeatures(true);
    const res = await fetchFeatures({ endpoint, appId, voterId });
    setLoadingFeatures(false);
    setFeatures((res && res.features) || []);
  }, [endpoint, appId, voterId]);

  const openFeatures = useCallback(() => {
    setScreen('features');
    loadFeatures();
  }, [loadFeatures]);

  const submitNewFeature = useCallback(async () => {
    const t = featTitle.trim();
    if (!t) return;
    setFeatTitle('');
    setShowAddFeature(false);
    await submitFeature({ endpoint, appId, title: t, authorId: voterId });
    loadFeatures();
  }, [featTitle, endpoint, appId, voterId, loadFeatures]);

  const vote = useCallback(async (f) => {
    setFeatures((cur) => cur.map(x => x.id === f.id
      ? { ...x, votedByMe: !x.votedByMe, votes: x.votes + (x.votedByMe ? -1 : 1) }
      : x));
    await toggleFeatureVote({ endpoint, id: f.id, voterId, voted: f.votedByMe });
  }, [endpoint, voterId]);

  const submit = useCallback(async () => {
    const text = (note || '').trim();
    if (!text || submitting) return;
    setSubmitting(true);
    const prefixed = category === 'Bug' ? text : `[${category}] ${text}`;
    const res = await postBug({ endpoint, appId, version, note: prefixed, screenshot: snapUri });
    setSubmitting(false);
    if (res && res.ok) {
      setNote('');
      if (screen === 'bugs') loadBugs();
      setScreen('sent');
    } else if (res && res.queued) {
      setToast('Bağlanılamadı — tekrar denenecek.');
      setNote('');
      setTimeout(() => setToast(null), 2400);
    } else {
      setToast('Hata. Tekrar dene.');
      setTimeout(() => setToast(null), 2000);
    }
  }, [note, category, submitting, endpoint, appId, version, snapUri, screen, loadBugs]);

  const filteredFeatures = (features || []).filter(f => statusBucket(f.status) === featFilter);

  return (
    <View style={{ flex: 1, backgroundColor: screen === 'features' ? T.bgLight : ((screen === 'bugs' || screen === 'bugDetail') ? T.darkBg : T.overlaySolid) }}>
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
        keyboardVerticalOffset={0}
      >
        {screen !== 'sent' && (
        <View style={{ paddingTop: 56, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Pressable
            onPress={screen === 'home' ? close : (screen === 'bugDetail' ? () => { setScreen('bugs'); setSelectedBug(null); } : () => setScreen('home'))}
            hitSlop={12}
            style={{
              width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
              backgroundColor: screen === 'features' ? '#E5E5EA' : T.circleOff,
            }}
          >
            <Text style={{ color: screen === 'features' ? '#3C3C43' : '#FFFFFF', fontSize: 16 }}>{screen === 'home' ? '✕' : '‹'}</Text>
          </Pressable>
          <Text style={{
            color: screen === 'features' ? '#000000' : '#FFFFFF',
            fontSize: screen === 'features' ? 28 : 16,
            fontWeight: screen === 'features' ? '700' : '600',
          }}>
            {screen === 'bugDetail' ? 'Bug detay' : screen === 'bugs' ? 'Buglar (admin)' : screen === 'features' ? 'Requests' : 'Send Feedback'}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {screen === 'home' && (
              <Pressable hitSlop={8} onPress={openFeatures} style={{ paddingHorizontal: 12, height: 32, borderRadius: 16, backgroundColor: T.circleOff, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '600' }}>Requests</Text>
              </Pressable>
            )}
            {(screen === 'bugs' && adminToken) && (
              <Pressable hitSlop={8} onPress={loadBugs} style={{ paddingHorizontal: 14, height: 32, borderRadius: 16, backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#FFF', fontSize: 13, fontWeight: '600' }}>↻</Text>
              </Pressable>
            )}
            {screen === 'features' && (
              <Pressable hitSlop={8} onPress={() => setShowAddFeature(v => !v)} style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#FFF', fontSize: 20, fontWeight: '600' }}>+</Text>
              </Pressable>
            )}
            {screen === 'home' && (<Pressable hitSlop={8} onPress={openBugs} style={{ paddingHorizontal: 12, height: 32, borderRadius: 16, backgroundColor: T.circleOff, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '600' }}>Bugs</Text></Pressable>)}
          </View>
        </View>
        )}

        {screen === 'home' && (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 40, opacity: toast ? 0 : 1 }} pointerEvents={toast ? 'none' : 'auto'}>
            <Animated.View style={{
              width: '48%', aspectRatio: 0.46, backgroundColor: T.cardWhite, borderRadius: 18, overflow: 'hidden',
              borderWidth: 2, borderColor: '#FFFFFF', transform: [{ scale }], opacity,
              shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 16, shadowOffset: { width: 0, height: 8 }, elevation: 8,
            }}>
              {snapUri ? (
                <Image source={{ uri: snapUri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
              ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: 'rgba(0,0,0,0.25)', fontSize: 13 }}>{appName}</Text>
                </View>
              )}
            </Animated.View>

            <View style={{ flexDirection: 'row', gap: 8, marginTop: 22 }}>
              {CATEGORIES.map((c) => {
                const on = category === c;
                return (
                  <Pressable
                    key={c}
                    onPress={() => setCategory(c)}
                    style={{
                      paddingHorizontal: 14, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center',
                      backgroundColor: on ? T.accent : T.chipOff,
                    }}
                  >
                    <Text style={{ color: '#FFFFFF', fontSize: 13, fontWeight: '600' }}>{c}</Text>
                  </Pressable>
                );
              })}
            </View>

            <Pressable onPress={pullUpdate} style={{ position: 'absolute', right: 14, top: '40%', alignItems: 'center', gap: 4 }}>
              <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: T.darkCard, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#FFF', fontSize: 18 }}>{pulling ? '⟳' : '⚙'}</Text>
              </View>
            </Pressable>
            {typeof CONFIG.abInfo === 'function' && (
              <Pressable onPress={showAbInfo} style={{ position: 'absolute', right: 14, top: '48%', alignItems: 'center', gap: 4 }}>
                <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: T.darkCard, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: '#FFF', fontSize: 13, fontWeight: '700' }}>AB</Text>
                </View>
              </Pressable>
            )}
          </View>
        )}

        {screen === 'bugs' && !adminToken && (
          <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 40 }}>
            <Text style={{ color: T.textMutedLight, fontSize: 13, marginBottom: 14 }}>
              Open Wishly, sign in and approve this device. Once you approve, this screen activates automatically — no copy/paste.
            </Text>
            <Pressable
              onPress={() => Linking.openURL((pair && pair.url) || ('https://wishly.tools/connect?app=' + encodeURIComponent(appId)))}
              style={{ height: 48, borderRadius: 14, backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center', marginBottom: 12 }}>
              <Text style={{ color: '#0A0E13', fontSize: 15, fontWeight: '700' }}>Open Wishly to approve →</Text>
            </Pressable>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginBottom: 18 }}>
              <ActivityIndicator size="small" color={T.accent} />
              <Text style={{ color: T.accent, fontSize: 12.5 }}>Waiting for approval… keep Wishly open, then return.</Text>
            </View>
            <Text style={{ color: T.textMutedLight, fontSize: 12, marginBottom: 8 }}>Or paste a key manually.</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: T.darkCard, borderRadius: 14, paddingHorizontal: 12 }}>
              <TextInput
                value={tokenInput}
                onChangeText={setTokenInput}
                placeholder="admin token"
                placeholderTextColor="#8C8B96"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                style={{ flex: 1, color: '#FFFFFF', fontSize: 14, paddingVertical: 12 }}
              />
              <Pressable onPress={saveToken} hitSlop={8}>
                <Text style={{ color: T.accent, fontSize: 14, fontWeight: '600', paddingLeft: 10 }}>Kaydet</Text>
              </Pressable>
            </View>
          </View>
        )}
        {screen === 'bugs' && adminToken && (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 100 }}>
            {loadingBugs && (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <ActivityIndicator color="#FFFFFF" />
              </View>
            )}
            {!loadingBugs && bugs && bugs.length === 0 && (
              <View style={{ paddingVertical: 60, alignItems: 'center' }}>
                <Text style={{ color: '#8C8B96', fontSize: 14 }}>Henüz bildirilmiş bug yok.</Text>
              </View>
            )}
            {!loadingBugs && bugs && bugs.map((b) => {
              const sc = adminStatusColors(b.status);
              const dot = severityDotColor(b.severity);
              const shotUri = bugShotUrl(endpoint, b.screenshot_path);
              return (
                <Pressable key={b.id} onPress={() => openBugDetail(b)} style={{ backgroundColor: T.darkBg, borderRadius: 18, padding: 12, marginBottom: 10, flexDirection: 'row', gap: 10 }}>
                  <View style={{ width: 44, height: 78, borderRadius: 8, backgroundColor: T.darkCard, overflow: 'hidden' }}>
                    {shotUri ? (
                      <Image source={{ uri: shotUri, headers: { 'x-admin-token': adminToken || '' } }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                    ) : null}
                  </View>
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 }}>
                        {dot ? <View style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: dot }} /> : null}
                        <Text style={{ color: '#FFFFFF', fontSize: 14, fontWeight: '600', flexShrink: 1 }} numberOfLines={1}>{b.note}</Text>
                      </View>
                      <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: sc.bg }}>
                        <Text style={{ color: sc.text, fontSize: 10, fontWeight: '600' }}>{sc.label}</Text>
                      </View>
                    </View>
                    <Text style={{ color: '#8C8B96', fontSize: 11, marginBottom: 4 }}>{timeAgo(b.created_at)} · v{b.version || '?'}</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: T.orange }} />
                      <Text style={{ color: T.orange, fontSize: 11, fontWeight: '700', letterSpacing: 0.4 }}>ADMIN ONLY</Text>
                    </View>
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>
        )}

        {screen === 'bugDetail' && selectedBug && (() => {
          const b = selectedBug;
          const sc = adminStatusColors(b.status);
          const shotUri = bugShotUrl(endpoint, b.screenshot_path);
          let triageNote = null;
          try {
            const parsed = JSON.parse(b.triage);
            const events = (parsed && parsed.events) || [];
            if (events.length) triageNote = events[events.length - 1].message;
          } catch {}
          let verdict = null;
          try { verdict = b.operator_verdict ? JSON.parse(b.operator_verdict) : null; }
          catch { verdict = b.operator_verdict; }
          const isFixed = String(b.status || '').toLowerCase() === 'fixed' || String(b.status || '').toLowerCase() === 'resolved';
          return (
            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 100 }}>
              {shotUri ? (
                <Pressable onPress={() => setFullscreenShot(true)} style={{ width: '100%', height: 260, borderRadius: 16, backgroundColor: T.darkCard, overflow: 'hidden', marginBottom: 14 }}>
                  <Image source={{ uri: shotUri, headers: { 'x-admin-token': adminToken || '' } }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                </Pressable>
              ) : (
                <View style={{ width: '100%', height: 100, borderRadius: 16, backgroundColor: T.darkCard, alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
                  <Text style={{ color: '#8C8B96', fontSize: 13 }}>Ekran görüntüsü yok</Text>
                </View>
              )}

              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, backgroundColor: sc.bg }}>
                  <Text style={{ color: sc.text, fontSize: 12, fontWeight: '700' }}>{sc.label}</Text>
                </View>
                {!!verdict && (
                  <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 10, backgroundColor: T.chipOff }}>
                    <Text style={{ color: '#FFFFFF', fontSize: 12, fontWeight: '600' }}>{String(verdict)}</Text>
                  </View>
                )}
              </View>

              <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '700', marginBottom: 8, lineHeight: 22 }}>{b.note}</Text>

              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
                <Text style={{ color: '#8C8B96', fontSize: 12 }}>v{b.version || '?'}</Text>
                <Text style={{ color: '#8C8B96', fontSize: 12 }}>·</Text>
                <Text style={{ color: '#8C8B96', fontSize: 12 }}>{b.source || 'unknown'}</Text>
                <Text style={{ color: '#8C8B96', fontSize: 12 }}>·</Text>
                <Text style={{ color: '#8C8B96', fontSize: 12 }}>{b.created_at ? new Date(b.created_at).toLocaleString() : ''}</Text>
              </View>

              {!!triageNote && (
                <View style={{ backgroundColor: T.darkCard, borderRadius: 14, padding: 12, marginBottom: 16 }}>
                  <Text style={{ color: '#8C8B96', fontSize: 11, fontWeight: '700', letterSpacing: 0.4, marginBottom: 6 }}>SON TRIAGE NOTU</Text>
                  <Text style={{ color: '#FFFFFF', fontSize: 13, lineHeight: 19 }}>{triageNote}</Text>
                </View>
              )}

              <Pressable
                onPress={() => setBugStatus(b, isFixed ? 'new' : 'fixed')}
                disabled={savingStatus}
                style={{ height: 48, borderRadius: 24, backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center', opacity: savingStatus ? 0.6 : 1 }}
              >
                <Text style={{ color: '#FFFFFF', fontSize: 15, fontWeight: '700' }}>
                  {savingStatus ? '…' : isFixed ? 'Reopen' : 'Mark fixed'}
                </Text>
              </Pressable>
            </ScrollView>
          );
        })()}

        <Modal visible={fullscreenShot} transparent animationType="fade" onRequestClose={() => setFullscreenShot(false)}>
          <Pressable onPress={() => setFullscreenShot(false)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.92)', alignItems: 'center', justifyContent: 'center' }}>
            {selectedBug && bugShotUrl(endpoint, selectedBug.screenshot_path) ? (
              <Image
                source={{ uri: bugShotUrl(endpoint, selectedBug.screenshot_path), headers: { 'x-admin-token': adminToken || '' } }}
                style={{ width: '100%', height: '80%' }}
                resizeMode="contain"
              />
            ) : null}
          </Pressable>
        </Modal>

        {screen === 'features' && (
          <View style={{ flex: 1 }}>
            <View style={{ paddingHorizontal: 14, marginTop: 4, marginBottom: 10 }}>
              <View style={{ flexDirection: 'row', backgroundColor: T.segTrack, borderRadius: 10, padding: 2 }}>
                {['Open', 'Planned', 'Done'].map((s) => {
                  const on = featFilter === s;
                  return (
                    <Pressable key={s} onPress={() => setFeatFilter(s)} style={{
                      flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: 'center',
                      backgroundColor: on ? '#FFFFFF' : 'transparent',
                      shadowColor: on ? '#000' : 'transparent', shadowOpacity: on ? 0.12 : 0, shadowRadius: 3, shadowOffset: { width: 0, height: 1 },
                    }}>
                      <Text style={{ color: on ? '#000000' : 'rgba(60,60,67,0.6)', fontSize: 13, fontWeight: '600' }}>{s}</Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {showAddFeature && (
              <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: T.cardWhite, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 6, marginHorizontal: 14, marginBottom: 10 }}>
                <TextInput
                  value={featTitle}
                  onChangeText={setFeatTitle}
                  placeholder="Yeni öneri…"
                  placeholderTextColor="rgba(60,60,67,0.4)"
                  autoFocus
                  style={{ flex: 1, color: '#000000', fontSize: 14, paddingVertical: 8 }}
                  onSubmitEditing={submitNewFeature}
                />
                <Pressable onPress={submitNewFeature} disabled={!featTitle.trim()} hitSlop={8}>
                  <Text style={{ color: featTitle.trim() ? T.accent : '#C7C7CC', fontSize: 14, fontWeight: '600', paddingLeft: 10 }}>Ekle</Text>
                </Pressable>
              </View>
            )}

            <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 100 }}>
              {loadingFeatures && (
                <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                  <ActivityIndicator color="#000000" />
                </View>
              )}
              {!loadingFeatures && filteredFeatures.length === 0 && (
                <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                  <Text style={{ color: T.textMutedLight, fontSize: 14 }}>Bu kategoride öneri yok.</Text>
                </View>
              )}
              {!loadingFeatures && filteredFeatures.map((f) => {
                const bucket = statusBucket(f.status);
                const tag = tagChipColors(bucket);
                return (
                  <View key={f.id} style={{
                    backgroundColor: T.cardWhite, borderRadius: 18, padding: 12, marginBottom: 10,
                    flexDirection: 'row', alignItems: 'center', gap: 10,
                  }}>
                    <Pressable onPress={() => vote(f)} style={{
                      minWidth: 44, paddingHorizontal: 8, paddingVertical: 8, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
                      backgroundColor: f.votedByMe ? T.blueChipBg : T.bgLight,
                      borderWidth: f.votedByMe ? 1 : 0, borderColor: T.blueChipBorder,
                    }}>
                      <Text style={{ color: f.votedByMe ? T.accent : '#3C3C43', fontSize: 11, fontWeight: '700' }}>▲</Text>
                      <Text style={{ color: f.votedByMe ? T.accent : '#3C3C43', fontSize: 13, fontWeight: '700' }}>{f.votes}</Text>
                    </Pressable>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: '#000000', fontSize: 16, fontWeight: '600' }}>{f.title}</Text>
                      {!!f.description && <Text style={{ color: T.textMutedLight, fontSize: 14, marginTop: 2 }}>{f.description}</Text>}
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
                        <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: tag.bg }}>
                          <Text style={{ color: tag.text, fontSize: 11, fontWeight: '600' }}>{bucket}</Text>
                        </View>
                        {!!f.created_at && <Text style={{ color: T.textMutedLight, fontSize: 12 }}>{timeAgo(f.created_at)} ago</Text>}
                      </View>
                    </View>
                  </View>
                );
              })}
            </ScrollView>
          </View>
        )}

        {toast && (
          <View style={{
            position: 'absolute', top: 110, left: 20, right: 20, alignSelf: 'center', zIndex: 999, elevation: 20,
            backgroundColor: T.darkCard, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 14,
            shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 12, shadowOffset: { width: 0, height: 4 },
          }}>
            <Text style={{ color: '#FFFFFF', fontSize: 13, lineHeight: 19, textAlign: 'center' }}>{toast}</Text>
          </View>
        )}

        {screen === 'home' && (
        <View style={{ paddingHorizontal: 14, paddingBottom: 28, paddingTop: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(255,255,255,0.98)', borderRadius: 22, paddingHorizontal: 14, paddingVertical: 8, gap: 8 }}>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Bug bildir…"
              placeholderTextColor="rgba(60,60,67,0.4)"
              multiline
              keyboardType="default"
              autoComplete="off"
              autoCapitalize="sentences"
              autoCorrect
              style={{ flex: 1, color: '#000000', fontSize: 15, maxHeight: 120, paddingVertical: 6 }}
            />
            <Pressable
              onPress={submit}
              disabled={!note.trim() || submitting}
              hitSlop={8}
              style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: note.trim() ? T.accent : '#D1D1D6', alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ color: '#FFF', fontSize: 15 }}>{submitting ? '…' : '↑'}</Text>
            </Pressable>
          </View>
          <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 8, textAlign: 'center' }}>
            {appId} · v{version} · Friday'e gönderilir
          </Text>
        </View>
        )}

        {screen === 'sent' && (
          <View style={{ flex: 1, justifyContent: 'flex-end' }}>
            <View style={{
              backgroundColor: T.cardWhite, borderTopLeftRadius: 32, borderTopRightRadius: 32,
              paddingHorizontal: 24, paddingTop: 32, paddingBottom: 40, alignItems: 'center',
            }}>
              <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: T.greenBg, alignItems: 'center', justifyContent: 'center', marginBottom: 18 }}>
                <Text style={{ color: T.green, fontSize: 34, fontWeight: '700' }}>✓</Text>
              </View>
              <Text style={{ color: '#000000', fontSize: 24, fontWeight: '700', marginBottom: 6 }}>Feedback sent</Text>
              <Text style={{ color: T.textMutedLight, fontSize: 15, marginBottom: 26, textAlign: 'center' }}>Thanks for helping us improve.</Text>
              <Pressable
                onPress={close}
                style={{ width: '100%', height: 52, borderRadius: 26, backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center' }}
              >
                <Text style={{ color: '#FFFFFF', fontSize: 16, fontWeight: '700' }}>Done</Text>
              </Pressable>
            </View>
          </View>
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

AppRegistry.registerComponent('FlayOverlay', () => FlayOverlay);

// Standalone public feature-request board — embed in Settings so it's reachable
// without the shake/screenshot trigger. Same backend, no admin token needed.
export function FeatureBoard({ style }) {
  const { appId, endpoint } = CONFIG;
  const [features, setFeatures] = useState(null);
  const [loading, setLoading] = useState(true);
  const [title, setTitle] = useState('');
  const [voterId, setVoterId] = useState(null);
  const [filter, setFilter] = useState('Open');

  useEffect(() => { getVoterId().then(setVoterId); }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const res = await fetchFeatures({ endpoint, appId, voterId });
    setLoading(false);
    setFeatures((res && res.features) || []);
  }, [endpoint, appId, voterId]);

  useEffect(() => { if (voterId) load(); }, [voterId, load]);

  const vote = useCallback(async (f) => {
    setFeatures((cur) => cur.map(x => x.id === f.id
      ? { ...x, votedByMe: !x.votedByMe, votes: x.votes + (x.votedByMe ? -1 : 1) }
      : x));
    await toggleFeatureVote({ endpoint, id: f.id, voterId, voted: f.votedByMe });
  }, [endpoint, voterId]);

  const submit = useCallback(async () => {
    const t = title.trim();
    if (!t) return;
    setTitle('');
    await submitFeature({ endpoint, appId, title: t, authorId: voterId });
    load();
  }, [title, endpoint, appId, voterId, load]);

  const filtered = (features || []).filter(f => statusBucket(f.status) === filter);

  return (
    <View style={[{ flex: 1, backgroundColor: T.bgLight }, style]}>
      <View style={{ paddingHorizontal: 14, paddingTop: 14, marginBottom: 10 }}>
        <View style={{ flexDirection: 'row', backgroundColor: T.segTrack, borderRadius: 10, padding: 2 }}>
          {['Open', 'Planned', 'Done'].map((s) => {
            const on = filter === s;
            return (
              <Pressable key={s} onPress={() => setFilter(s)} style={{
                flex: 1, paddingVertical: 7, borderRadius: 8, alignItems: 'center',
                backgroundColor: on ? '#FFFFFF' : 'transparent',
              }}>
                <Text style={{ color: on ? '#000000' : 'rgba(60,60,67,0.6)', fontSize: 13, fontWeight: '600' }}>{s}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      <ScrollView contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 100 }}>
        {loading && (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}><ActivityIndicator color="#000000" /></View>
        )}
        {!loading && filtered.length === 0 && (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <Text style={{ color: T.textMutedLight, fontSize: 14 }}>Bu kategoride öneri yok.</Text>
          </View>
        )}
        {!loading && filtered.map((f) => {
          const bucket = statusBucket(f.status);
          const tag = tagChipColors(bucket);
          return (
            <View key={f.id} style={{ backgroundColor: T.cardWhite, borderRadius: 18, padding: 12, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Pressable onPress={() => vote(f)} style={{
                minWidth: 44, paddingHorizontal: 8, paddingVertical: 8, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
                backgroundColor: f.votedByMe ? T.blueChipBg : T.bgLight,
                borderWidth: f.votedByMe ? 1 : 0, borderColor: T.blueChipBorder,
              }}>
                <Text style={{ color: f.votedByMe ? T.accent : '#3C3C43', fontSize: 11, fontWeight: '700' }}>▲</Text>
                <Text style={{ color: f.votedByMe ? T.accent : '#3C3C43', fontSize: 13, fontWeight: '700' }}>{f.votes}</Text>
              </Pressable>
              <View style={{ flex: 1 }}>
                <Text style={{ color: '#000000', fontSize: 16, fontWeight: '600' }}>{f.title}</Text>
                {!!f.description && <Text style={{ color: T.textMutedLight, fontSize: 14, marginTop: 2 }}>{f.description}</Text>}
                <View style={{ paddingHorizontal: 8, paddingVertical: 3, borderRadius: 8, backgroundColor: tag.bg, alignSelf: 'flex-start', marginTop: 6 }}>
                  <Text style={{ color: tag.text, fontSize: 11, fontWeight: '600' }}>{bucket}</Text>
                </View>
              </View>
            </View>
          );
        })}
      </ScrollView>
      <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: T.cardWhite, borderRadius: 22, paddingHorizontal: 14, paddingVertical: 6, margin: 14 }}>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder="Yeni öneri…"
          placeholderTextColor="rgba(60,60,67,0.4)"
          style={{ flex: 1, color: '#000000', fontSize: 14, paddingVertical: 8 }}
        />
        <Pressable onPress={submit} disabled={!title.trim()} hitSlop={8}>
          <Text style={{ color: title.trim() ? T.accent : '#C7C7CC', fontSize: 14, fontWeight: '600', paddingLeft: 10 }}>Ekle</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default FlayProvider;
