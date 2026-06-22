import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppRegistry, View, Text, Pressable, TextInput, Platform, Modal, Image, Animated, Easing,
  KeyboardAvoidingView, StatusBar, NativeEventEmitter, NativeModules, ScrollView, ActivityIndicator, AppState,
} from 'react-native';

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
  endpoint: 'http://100.107.27.3:8091/api/bug-reports',
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

function fetchBugs({ endpoint, appId }) {
  const url = `${endpoint}?appId=${encodeURIComponent(appId)}`;
  return fetch(url).then(r => r.json()).catch((e) => ({ ok: false, error: String(e) }));
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
  const [bugs, setBugs] = useState(null);
  const [loadingBugs, setLoadingBugs] = useState(false);
  const { appName, appId, version, endpoint } = CONFIG;

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
    setLoadingBugs(true);
    const res = await fetchBugs({ endpoint, appId });
    setLoadingBugs(false);
    if (res && res.ok) setBugs(res.items || []);
    else setBugs([]);
  }, [endpoint, appId]);

  const openBugs = useCallback(() => {
    setScreen('bugs');
    loadBugs();
  }, [loadBugs]);

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
          <Pressable onPress={screen === 'bugs' ? () => setScreen('home') : close} hitSlop={12} style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: T.panel, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: T.text, fontSize: 18 }}>{screen === 'bugs' ? '‹' : '⌂'}</Text>
          </Pressable>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text style={{ color: T.text, fontSize: 17, fontWeight: '600' }}>{screen === 'bugs' ? 'Buglar' : 'flay'}</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Pressable hitSlop={8} onPress={screen === 'bugs' ? loadBugs : openBugs} style={{ paddingHorizontal: 16, height: 38, borderRadius: 19, backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: '#FFF', fontSize: 14, fontWeight: '600' }}>{screen === 'bugs' ? '↻' : 'Bugs'}</Text>
            </Pressable>
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
            <View style={{ position: 'absolute', right: 14, top: '46%', alignItems: 'center', gap: 4 }}>
              <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: T.toolsBlue, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#FFF', fontSize: 22 }}>⚙</Text>
              </View>
              <View style={{ paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.55)' }}>
                <Text style={{ color: T.text, fontSize: 11 }}>Tools</Text>
              </View>
            </View>
          </View>
        )}

        {screen === 'bugs' && (
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
                  <Text style={{ color: T.muted, fontSize: 11 }}>{timeAgo(b.ts)} · v{b.version || '?'}</Text>
                  <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 8, backgroundColor: T.panelMuted }}>
                    <Text style={{ color: T.text, fontSize: 10 }}>{b.status}</Text>
                  </View>
                </View>
                <Text style={{ color: T.text, fontSize: 14 }}>{b.note}</Text>
              </View>
            ))}
          </ScrollView>
        )}

        {toast && (
          <View style={{ position: 'absolute', top: 110, alignSelf: 'center', backgroundColor: T.panel, paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12 }}>
            <Text style={{ color: T.text, fontSize: 13 }}>{toast}</Text>
          </View>
        )}

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
      </KeyboardAvoidingView>
    </View>
  );
}

AppRegistry.registerComponent('FlayOverlay', () => FlayOverlay);

export default FlayProvider;
