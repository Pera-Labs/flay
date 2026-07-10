import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppRegistry, View, Text, Pressable, TextInput, Platform, Modal, Image, Animated, Easing,
  KeyboardAvoidingView, StatusBar, NativeEventEmitter, NativeModules, ScrollView, ActivityIndicator, AppState,
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

const FlayCtx = createContext({ enabled: false, open: () => {}, close: () => {} });

const T = {
  bg: '#000000',
  panel: '#15151D',
  panelMuted: '#1C1C26',
  text: '#FFFFFF',
  muted: '#8C8B96',
  line: 'rgba(255,255,255,0.08)',
  accent: '#6E5BFF',
  toolsBlue: '#1F8FFF',
  snapCard: '#FFFFFF',
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
    const uri = await captureNow();
    setSnapUri(uri);
    nativePresent();
  }, [captureNow]);

  const handleClose = useCallback(() => { nativeDismiss(); }, []);

  useEffect(() => {
    const mod = NativeModules && NativeModules.FlayBridge;
    if (!mod) return;
    const emitter = new NativeEventEmitter(mod);
    const sub = emitter.addListener('FlayOpen', () => { handleOpen(); });
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

function FlayOverlay({ snapUri }) {
  const [screen, setScreen] = useState('home');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState(null);
  const [pulling, setPulling] = useState(false);
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
  const [adminToken, setAdminToken] = useState(null);
  const [tokenInput, setTokenInput] = useState('');
  const [features, setFeatures] = useState(null);
  const [loadingFeatures, setLoadingFeatures] = useState(false);
  const [featTitle, setFeatTitle] = useState('');
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

  const openBugs = useCallback(() => {
    setScreen('bugs');
    if (adminToken) loadBugs();
  }, [loadBugs, adminToken]);

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
    const res = await postBug({ endpoint, appId, version, note: text, screenshot: snapUri });
    setSubmitting(false);
    if (res && res.ok) {
      setToast('Gönderildi.');
      setNote('');
      if (screen === 'bugs') loadBugs();
      setTimeout(() => { setToast(null); }, 1400);
    } else if (res && res.queued) {
      setToast('Bağlanılamadı — tekrar denenecek.');
      setNote('');
      setTimeout(() => setToast(null), 2400);
    } else {
      setToast('Hata. Tekrar dene.');
      setTimeout(() => setToast(null), 2000);
    }
  }, [note, submitting, endpoint, appId, version, screen, loadBugs]);

  return (
    <View style={{ flex: 1, backgroundColor: T.bg }}>
      <StatusBar barStyle="light-content" />
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
        keyboardVerticalOffset={0}
      >
        <View style={{ paddingTop: 56, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Pressable onPress={screen === 'home' ? close : () => setScreen('home')} hitSlop={12} style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: T.panel, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: T.text, fontSize: 18 }}>{screen === 'home' ? '⌂' : '‹'}</Text>
          </Pressable>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ color: T.text, fontSize: 17, fontWeight: '600' }}>
              {screen === 'bugs' ? 'Buglar (admin)' : screen === 'features' ? 'Öneriler' : 'flay'}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            {screen === 'home' && (
              <>
                <Pressable hitSlop={8} onPress={openFeatures} style={{ paddingHorizontal: 12, height: 38, borderRadius: 19, backgroundColor: T.panel, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: T.text, fontSize: 13, fontWeight: '600' }}>Öneriler</Text>
                </Pressable>
                <Pressable hitSlop={8} onPress={openBugs} style={{ paddingHorizontal: 12, height: 38, borderRadius: 19, backgroundColor: T.panel, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: T.text, fontSize: 13, fontWeight: '600' }}>Bugs</Text>
                </Pressable>
              </>
            )}
            {(screen === 'bugs' && adminToken) && (
              <Pressable hitSlop={8} onPress={loadBugs} style={{ paddingHorizontal: 14, height: 38, borderRadius: 19, backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#FFF', fontSize: 14, fontWeight: '600' }}>↻</Text>
              </Pressable>
            )}
            {screen === 'features' && (
              <Pressable hitSlop={8} onPress={loadFeatures} style={{ paddingHorizontal: 14, height: 38, borderRadius: 19, backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#FFF', fontSize: 14, fontWeight: '600' }}>↻</Text>
              </Pressable>
            )}
          </View>
        </View>

        {screen === 'home' && (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Animated.View style={{ width: '60%', aspectRatio: 0.46, backgroundColor: T.snapCard, borderRadius: 28, overflow: 'hidden', transform: [{ scale }], opacity }}>
              {snapUri ? (
                <Image source={{ uri: snapUri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
              ) : (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: 'rgba(0,0,0,0.25)', fontSize: 13 }}>{appName}</Text>
                </View>
              )}
            </Animated.View>
            <Pressable onPress={pullUpdate} style={{ position: 'absolute', right: 14, top: '46%', alignItems: 'center', gap: 4 }}>
              <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: T.toolsBlue, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#FFF', fontSize: 22 }}>{pulling ? '⟳' : '⚙'}</Text>
              </View>
              <View style={{ paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.55)' }}>
                <Text style={{ color: T.text, fontSize: 11 }}>{pulling ? 'Çekiyor…' : 'Yeni sürümü çek'}</Text>
              </View>
            </Pressable>
          </View>
        )}

        {screen === 'bugs' && !adminToken && (
          <View style={{ flex: 1, paddingHorizontal: 20, paddingTop: 40 }}>
            <Text style={{ color: T.muted, fontSize: 13, marginBottom: 14 }}>
              Bug listesi sadece operatöre açık. Admin token gir.
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: T.panel, borderRadius: 14, paddingHorizontal: 12 }}>
              <TextInput
                value={tokenInput}
                onChangeText={setTokenInput}
                placeholder="admin token"
                placeholderTextColor={T.muted}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                style={{ flex: 1, color: T.text, fontSize: 14, paddingVertical: 12 }}
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
                <ActivityIndicator color={T.text} />
              </View>
            )}
            {!loadingBugs && bugs && bugs.length === 0 && (
              <View style={{ paddingVertical: 60, alignItems: 'center' }}>
                <Text style={{ color: T.muted, fontSize: 14 }}>Henüz bildirilmiş bug yok.</Text>
              </View>
            )}
            {!loadingBugs && bugs && bugs.map((b) => (
              <View key={b.id} style={{ backgroundColor: T.panel, borderRadius: 14, padding: 12, marginBottom: 10 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <Text style={{ color: T.muted, fontSize: 11 }}>{timeAgo(b.created_at)} · v{b.version || '?'}</Text>
                  <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, backgroundColor: T.panelMuted }}>
                    <Text style={{ color: T.text, fontSize: 10 }}>{b.status}</Text>
                  </View>
                </View>
                <Text style={{ color: T.text, fontSize: 14 }}>{b.note}</Text>
              </View>
            ))}
          </ScrollView>
        )}

        {screen === 'features' && (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 14, paddingBottom: 100 }}>
            {loadingFeatures && (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <ActivityIndicator color={T.text} />
              </View>
            )}
            {!loadingFeatures && features && features.length === 0 && (
              <View style={{ paddingVertical: 40, alignItems: 'center' }}>
                <Text style={{ color: T.muted, fontSize: 14 }}>Henüz öneri yok — ilk sen ekle.</Text>
              </View>
            )}
            {!loadingFeatures && features && features.map((f) => (
              <View key={f.id} style={{ backgroundColor: T.panel, borderRadius: 14, padding: 12, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <Pressable onPress={() => vote(f)} style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: f.votedByMe ? T.accent : T.panelMuted, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: '#FFF', fontSize: 13, fontWeight: '700' }}>▲{f.votes}</Text>
                </Pressable>
                <View style={{ flex: 1 }}>
                  <Text style={{ color: T.text, fontSize: 14, fontWeight: '600' }}>{f.title}</Text>
                  {!!f.description && <Text style={{ color: T.muted, fontSize: 12, marginTop: 2 }}>{f.description}</Text>}
                </View>
              </View>
            ))}
            <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: T.panel, borderRadius: 22, paddingHorizontal: 14, paddingVertical: 6, marginTop: 8 }}>
              <TextInput
                value={featTitle}
                onChangeText={setFeatTitle}
                placeholder="Yeni öneri…"
                placeholderTextColor={T.muted}
                style={{ flex: 1, color: T.text, fontSize: 14, paddingVertical: 8 }}
              />
              <Pressable onPress={submitNewFeature} disabled={!featTitle.trim()} hitSlop={8}>
                <Text style={{ color: featTitle.trim() ? T.accent : T.muted, fontSize: 14, fontWeight: '600', paddingLeft: 10 }}>Ekle</Text>
              </Pressable>
            </View>
          </ScrollView>
        )}

        {toast && (
          <View style={{ position: 'absolute', top: 110, alignSelf: 'center', backgroundColor: T.panel, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12 }}>
            <Text style={{ color: T.text, fontSize: 13 }}>{toast}</Text>
          </View>
        )}

        {screen === 'home' && (
        <View style={{ paddingHorizontal: 14, paddingBottom: 28, paddingTop: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: T.panel, borderRadius: 22, paddingHorizontal: 14, paddingVertical: 8, gap: 8 }}>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Bug bildir…"
              placeholderTextColor={T.muted}
              multiline
              keyboardType="default"
              autoComplete="off"
              autoCapitalize="sentences"
              autoCorrect
              style={{ flex: 1, color: T.text, fontSize: 15, maxHeight: 120, paddingVertical: 6 }}
            />
            <Pressable
              onPress={submit}
              disabled={!note.trim() || submitting}
              hitSlop={8}
              style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: note.trim() ? T.accent : T.panelMuted, alignItems: 'center', justifyContent: 'center' }}
            >
              <Text style={{ color: '#FFF', fontSize: 16 }}>{submitting ? '…' : '↑'}</Text>
            </Pressable>
          </View>
          <Text style={{ color: T.muted, fontSize: 11, marginTop: 8, textAlign: 'center' }}>
            {appId} · v{version} · Friday'e gönderilir
          </Text>
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

  return (
    <View style={[{ flex: 1, backgroundColor: T.bg }, style]}>
      <ScrollView contentContainerStyle={{ padding: 14, paddingBottom: 100 }}>
        {loading && (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}><ActivityIndicator color={T.text} /></View>
        )}
        {!loading && features && features.length === 0 && (
          <View style={{ paddingVertical: 40, alignItems: 'center' }}>
            <Text style={{ color: T.muted, fontSize: 14 }}>Henüz öneri yok — ilk sen ekle.</Text>
          </View>
        )}
        {!loading && features && features.map((f) => (
          <View key={f.id} style={{ backgroundColor: T.panel, borderRadius: 14, padding: 12, marginBottom: 10, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Pressable onPress={() => vote(f)} style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: f.votedByMe ? T.accent : T.panelMuted, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: '#FFF', fontSize: 13, fontWeight: '700' }}>▲{f.votes}</Text>
            </Pressable>
            <View style={{ flex: 1 }}>
              <Text style={{ color: T.text, fontSize: 14, fontWeight: '600' }}>{f.title}</Text>
              {!!f.description && <Text style={{ color: T.muted, fontSize: 12, marginTop: 2 }}>{f.description}</Text>}
            </View>
          </View>
        ))}
      </ScrollView>
      <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: T.panel, borderRadius: 22, paddingHorizontal: 14, paddingVertical: 6, margin: 14 }}>
        <TextInput
          value={title}
          onChangeText={setTitle}
          placeholder="Yeni öneri…"
          placeholderTextColor={T.muted}
          style={{ flex: 1, color: T.text, fontSize: 14, paddingVertical: 8 }}
        />
        <Pressable onPress={submit} disabled={!title.trim()} hitSlop={8}>
          <Text style={{ color: title.trim() ? T.accent : T.muted, fontSize: 14, fontWeight: '600', paddingLeft: 10 }}>Ekle</Text>
        </Pressable>
      </View>
    </View>
  );
}

export default FlayProvider;
