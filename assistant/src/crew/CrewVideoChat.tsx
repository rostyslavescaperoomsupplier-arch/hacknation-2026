/** Crew calls between terminals ("Łączność" tab): WebSocket signalling (server/crew-video.ts) + browser WebRTC,
 *  media goes peer-to-peer. Each browser is one terminal from the crew database (GET /api/crew/terminals) or,
 *  when the database is down, a free-text name. The choice is remembered in localStorage and the terminal
 *  reconnects by itself, so it can be called from anywhere in the app (the incoming-call dialog is a portal). */
import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Lang } from '../types';
import { MewkaReact } from '../../../mewka/src/mewka/MewkaReact';
import type { MewkaState } from '../../../mewka/src';
import { CallIcon, type CallIconName } from './icons';
import { startTone, stopTone, unlockAudio } from './tones';
import './crew-video.css';

type Media = 'audio' | 'video';
type Person = { id: string; name: string; terminal?: string; place?: string; busy?: boolean };
type Incoming = Person & { media: Media };
type Phase = 'offline' | 'connecting' | 'ready' | 'dialing' | 'incoming' | 'negotiating' | 'active';
type Wire =
  | { type: 'welcome'; id: string; room: string; peers: Person[]; iceServers?: RTCIceServer[]; iceTransportPolicy?: RTCIceTransportPolicy }
  | { type: 'peer:joined'; peer: Person }
  | { type: 'peer:left'; id: string }
  | { type: 'peer:status'; id: string; busy: boolean }
  | { type: 'call:invite'; from: string; name: string; terminal?: string; place?: string; media?: Media }
  | { type: 'call:accept'; from: string }
  | { type: 'call:reject' | 'call:cancel' | 'call:hangup'; from: string; reason?: string }
  | { type: 'rtc:offer' | 'rtc:answer'; from: string; sdp: string }
  | { type: 'rtc:ice'; from: string; candidate: RTCIceCandidateInit }
  | { type: 'error'; code?: string; message: string };

/** Terminal row from the crew database (same JSON as the crew server's /api/terminals). */
type TerminalRow = { code: string; room_code: string; room_name: string };
/** Who this browser is. `terminal` / `place` are empty for a free-text name. */
type Identity = { name: string; terminal?: string; place?: string };

/** Room code of the navigation bridge in the crew database (shared/crew-map.ts: D4-01 "Mostek nawigacyjny", zone bridge). */
export const BRIDGE_ROOM = 'D4-01';
const DEFAULT_ROOM = 'JANTAR-UNITY';
const ROOM_RE = /^[A-Z0-9_-]{3,24}$/;
const LS_ID = 'crew-terminal';
const LS_ROOM = 'crew-room';

const PL = {
  kicker: 'Łączność wewnętrzna', title: 'Łączność', intro: 'Rozmowy głosowe i wideo między terminalami w sieci statku.',
  thisTerminal: 'Ten terminal', change: 'Zmień', setupTitle: 'Wybierz ten terminal',
  setupIntro: 'Wskaż, gdzie stoi to urządzenie. Inne terminale zobaczą tę nazwę i będą mogły tu zadzwonić.',
  terminal: 'Terminal', pickOne: 'Wybierz z listy…', manual: 'Inna nazwa (wpisz ręcznie)', name: 'Nazwa terminala',
  namePh: 'np. Biuro bosmana', dbDown: 'Lista terminali z bazy załogi jest niedostępna. Wpisz nazwę ręcznie.',
  dbLoading: 'Wczytywanie listy terminali…', retry: 'Spróbuj ponownie', deck: (d: string) => `Pokład D${d}`, channel: 'Kanał (zaawansowane)', channelHint: 'Wszystkie terminale statku używają tego samego kanału.',
  save: 'Połącz terminal', cancel: 'Anuluj', disconnect: 'Rozłącz terminal',
  online: 'Online', connecting: 'Łączenie z serwerem…', offline: 'Offline',
  bridge: 'Połącz z mostkiem', bridgeSub: 'Mostek nawigacyjny · rozmowa głosowa', bridgeOff: 'Mostek jest teraz offline',
  bridgeBusy: 'Mostek prowadzi inną rozmowę, możesz spróbować', bridgeSelf: 'Ten terminal stoi na mostku.',
  terminals: 'Terminale', onlineCount: (n: number) => `${n} online`, offlineList: (n: number) => `Offline (${n})`,
  empty: 'Żaden inny terminal nie jest teraz online.', busy: 'w rozmowie', available: 'dostępny',
  voice: 'Głos', video: 'Wideo', voiceFor: 'Połączenie głosowe', videoFor: 'Połączenie wideo',
  incomingVoice: 'Połączenie głosowe', incomingVideo: 'Połączenie wideo', incoming: 'Połączenie przychodzące',
  accept: 'Odbierz', acceptVoice: 'Odbierz bez kamery', decline: 'Odrzuć', escHint: 'Esc odrzuca',
  calling: 'Dzwonię do', negotiating: 'Łączenie z', active: 'Rozmowa z', ended: 'Połączenie zakończone.',
  end: 'Rozłącz', micOn: 'Wycisz', micOff: 'Włącz mikrofon', camOn: 'Wyłącz kamerę', camOff: 'Włącz kamerę',
  local: 'Ty', remote: 'Rozmówca', waitingVideo: 'Oczekiwanie na obraz…', voiceOnly: 'Rozmowa głosowa',
  note: 'Wersja demonstracyjna: kanał nie jest hasłem. W sytuacji zagrożenia używaj radia UKF i alarmu statku.',
  missed: 'Rozmowa zakończona lub odrzucona.', declined: 'Rozmówca odrzucił połączenie.', noAnswer: 'Nikt nie odebrał.',
  peerBusy: 'Terminal prowadzi inną rozmowę.', failed: 'Nie udało się nawiązać połączenia.',
  serverDown: 'Brak połączenia z serwerem statku. Ponawiam…',
  errSecure: 'Kamera i mikrofon działają tylko przez HTTPS lub localhost.',
  errNoRtc: 'Ta przeglądarka nie obsługuje połączeń WebRTC.',
  errDenied: 'Brak zgody na mikrofon. Zezwól na dostęp w ustawieniach przeglądarki (kłódka przy adresie) i spróbuj ponownie.',
  errBusyDev: 'Mikrofon lub kamera są zajęte przez inną aplikację.',
  errNoMic: 'Nie znaleziono mikrofonu: ten terminal tylko słucha i ogląda.',
  camDenied: 'Brak zgody na kamerę: rozmowa tylko z dźwiękiem.',
  camMissing: 'Kamera niedostępna: rozmowa tylko z dźwiękiem.',
  errMedia: 'Nie udało się włączyć mikrofonu ani kamery.',
  codes: {
    offline: 'Ten terminal jest już offline.', 'in-call': 'Trwa już inna rozmowa.', rate: 'Za dużo prób. Odczekaj chwilę.',
    invalid: 'Nazwa: 2 do 40 znaków. Kanał: 3 do 24 znaków (A-Z, 0-9, - lub _).', full: 'Kanał jest pełny.',
    'rooms-full': 'Serwer ma za dużo kanałów.',
    'rooms-ip': 'Z tego adresu otwarto już za dużo kanałów. Wybierz istniejący kanał.',
    'name-taken': 'Ta nazwa jest już zajęta na tym kanale. Wybierz inną nazwę.',
    'terminal-taken': 'Ten terminal jest już połączony na tym kanale. Wybierz inny terminal lub wpisz nazwę.',
  } as Record<string, string>,
  signalling: 'Błąd sygnalizacji połączenia.',
};
type Strings = typeof PL;
const EN: Strings = {
  kicker: 'Internal communication', title: 'Comms', intro: 'Voice and video calls between terminals on the ship network.',
  thisTerminal: 'This terminal', change: 'Change', setupTitle: 'Choose this terminal',
  setupIntro: 'Pick where this device stands. Other terminals will see this name and can call it.',
  terminal: 'Terminal', pickOne: 'Choose from the list…', manual: 'Other name (type it)', name: 'Terminal name',
  namePh: 'e.g. Bosun office', dbDown: 'The terminal list from the crew database is unavailable. Type a name.',
  dbLoading: 'Loading terminals…', retry: 'Retry', deck: (d: string) => `Deck D${d}`, channel: 'Channel (advanced)', channelHint: 'All terminals of the ship use the same channel.',
  save: 'Connect terminal', cancel: 'Cancel', disconnect: 'Disconnect terminal',
  online: 'Online', connecting: 'Connecting to server…', offline: 'Offline',
  bridge: 'Call the bridge', bridgeSub: 'Navigation bridge · voice call', bridgeOff: 'The bridge is offline now',
  bridgeBusy: 'The bridge is in another call, you can still try', bridgeSelf: 'This terminal is on the bridge.',
  terminals: 'Terminals', onlineCount: (n: number) => `${n} online`, offlineList: (n: number) => `Offline (${n})`,
  empty: 'No other terminal is online right now.', busy: 'in a call', available: 'available',
  voice: 'Voice', video: 'Video', voiceFor: 'Voice call', videoFor: 'Video call',
  incomingVoice: 'Voice call', incomingVideo: 'Video call', incoming: 'Incoming call',
  accept: 'Answer', acceptVoice: 'Answer without camera', decline: 'Decline', escHint: 'Esc declines',
  calling: 'Calling', negotiating: 'Connecting to', active: 'In a call with', ended: 'Call ended.',
  end: 'Hang up', micOn: 'Mute', micOff: 'Unmute', camOn: 'Camera off', camOff: 'Camera on',
  local: 'You', remote: 'Caller', waitingVideo: 'Waiting for video…', voiceOnly: 'Voice call',
  note: 'Demo: the channel is not a password. In an emergency use the VHF radio and the ship alarm.',
  missed: 'Call ended or declined.', declined: 'The call was declined.', noAnswer: 'No answer.',
  peerBusy: 'That terminal is in another call.', failed: 'Could not establish the call.',
  serverDown: 'Cannot reach the ship server. Retrying…',
  errSecure: 'Camera and microphone need HTTPS or localhost.',
  errNoRtc: 'This browser does not support WebRTC calls.',
  errDenied: 'Microphone permission denied. Allow it in the browser settings (padlock next to the address) and try again.',
  errBusyDev: 'The microphone or camera is used by another application.',
  errNoMic: 'No microphone found: this terminal can only listen and watch.',
  camDenied: 'Camera permission denied: voice only.',
  camMissing: 'Camera unavailable: voice only.',
  errMedia: 'Could not start the microphone or camera.',
  codes: {
    offline: 'That terminal is offline now.', 'in-call': 'Another call is in progress.', rate: 'Too many attempts. Wait a moment.',
    invalid: 'Name: 2 to 40 characters. Channel: 3 to 24 characters (A-Z, 0-9, - or _).', full: 'The channel is full.',
    'rooms-full': 'The server has too many channels.',
    'rooms-ip': 'Too many channels were opened from this address. Pick an existing channel.',
    'name-taken': 'This name is already used in this channel. Pick another name.',
    'terminal-taken': 'This terminal is already connected to this channel. Pick another terminal or type a name.',
  },
  signalling: 'Call signalling error.',
};

/** ICE servers when the signalling server sends none (older server): build-time VITE_CREW_ICE_SERVERS, else public
 *  STUN. Normally the server delivers them in `welcome` (server/crew-video.ts iceConfig, env CREW_ICE_SERVERS /
 *  CREW_TURN_*). With NO ICE server only host candidates exist and two devices on different networks never connect. */
function fallbackIceServers(): RTCIceServer[] {
  const value = import.meta.env.VITE_CREW_ICE_SERVERS as string | undefined;
  if (value) {
    try { const parsed: unknown = JSON.parse(value); if (Array.isArray(parsed)) return parsed as RTCIceServer[]; }
    catch { /* invalid JSON: public STUN below */ }
  }
  return [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
}

function loadIdentity(): Identity | null {
  try {
    const raw = localStorage.getItem(LS_ID);
    if (raw) {
      const v = JSON.parse(raw) as Partial<Identity>;
      if (typeof v.name === 'string' && v.name.trim().length >= 2)
        return { name: v.name, terminal: typeof v.terminal === 'string' ? v.terminal : undefined, place: typeof v.place === 'string' ? v.place : undefined };
    }
    const legacy = localStorage.getItem('crew-name'); // first version of the video chat stored only a name
    return legacy && legacy.trim().length >= 2 ? { name: legacy.trim() } : null;
  } catch { return null; }
}
function loadRoom(): string {
  try { const r = localStorage.getItem(LS_ROOM); return r && ROOM_RE.test(r) ? r : DEFAULT_ROOM; } catch { return DEFAULT_ROOM; }
}
const nameFor = (row: TerminalRow) => row.room_name.slice(0, 40);
const deckOf = (code: string) => /^D(\d)/.exec(code)?.[1] ?? '';
const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Polish (or English) text for a getUserMedia failure. */
function mediaErrorText(t: Strings, e: unknown): string {
  const name = e instanceof DOMException || e instanceof Error ? e.name : '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') return t.errDenied;
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') return t.errBusyDev;
  if (name === 'SecurityError') return t.errSecure;
  return t.errMedia;
}

export default function CrewVideoChat({ lang, onOpen }: { lang: Lang; onOpen?: () => void }) {
  const t = lang === 'pl' ? PL : EN;
  const [identity, setIdentity] = useState<Identity | null>(loadIdentity);
  const [room, setRoom] = useState(loadRoom);
  const [editing, setEditing] = useState(() => !loadIdentity());
  const [terminals, setTerminals] = useState<TerminalRow[] | null | 'loading'>('loading');
  const [phase, setPhase] = useState<Phase>('offline');
  const [peers, setPeers] = useState<Person[]>([]);
  const [incoming, setIncoming] = useState<Incoming | null>(null);
  const [partner, setPartner] = useState<Person | null>(null);
  const [callMedia, setCallMedia] = useState<Media>('video');
  const [warning, setWarning] = useState('');
  const [announce, setAnnounce] = useState('');
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);
  const [hasLocalVideo, setHasLocalVideo] = useState(false);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [mood, setMood] = useState<MewkaState>('idle');

  const socketRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const phaseRef = useRef<Phase>('offline');
  const partnerRef = useRef<Person | null>(null);
  const mediaRef = useRef<Media>('video');
  const selfIdRef = useRef('');
  const rtcConfigRef = useRef<RTCConfiguration>({ iceServers: fallbackIceServers() });
  const desiredRef = useRef(false);
  const loginRef = useRef<{ name: string; room: string; terminal?: string; place?: string }>({ name: '', room: '' });
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ringTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const retryCountRef = useRef(0);
  const openRef = useRef<() => void>(() => {});
  const receiveRef = useRef<(e: Wire) => void>(() => {});
  const tRef = useRef(t);
  tRef.current = t;

  const connected = phase !== 'offline' && phase !== 'connecting';
  const inCall = phase === 'dialing' || phase === 'negotiating' || phase === 'active';

  function move(next: Phase) { phaseRef.current = next; setPhase(next); }
  function setPartnerBoth(next: Person | null) { partnerRef.current = next; setPartner(next); }
  function transmit(payload: object): boolean {
    const socket = socketRef.current;
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(payload));
    return true;
  }
  function clearRing() {
    if (ringTimerRef.current) clearTimeout(ringTimerRef.current);
    ringTimerRef.current = null;
  }
  function releaseMedia() {
    pcRef.current?.close();
    pcRef.current = null;
    for (const track of localStreamRef.current?.getTracks() ?? []) track.stop();
    localStreamRef.current = null;
    remoteStreamRef.current = null;
    for (const el of [localVideoRef.current, remoteVideoRef.current, remoteAudioRef.current]) if (el) el.srcObject = null;
    remoteCandidatesRef.current = [];
    setHasRemoteVideo(false);
    setHasLocalVideo(false);
    setMicEnabled(true);
    setCamEnabled(true);
    setStartedAt(null);
  }
  function resetCall(message = '') {
    generationRef.current++;
    clearRing();
    releaseMedia();
    setIncoming(null);
    setPartnerBoth(null);
    setWarning(message);
    if (message || phaseRef.current === 'active') setAnnounce(message || tRef.current.ended);
    move(desiredRef.current && socketRef.current?.readyState === WebSocket.OPEN ? 'ready' : desiredRef.current ? 'connecting' : 'offline');
    setMood(message ? 'unsure' : 'idle');
  }
  function hangup() {
    if (partnerRef.current) {
      const type = phaseRef.current === 'dialing' ? 'call:cancel' :
        phaseRef.current === 'incoming' ? 'call:reject' : 'call:hangup';
      transmit({ type, to: partnerRef.current.id });
    }
    resetCall();
  }
  function connectionTimeout() {
    clearRing();
    ringTimerRef.current = setTimeout(() => {
      if (phaseRef.current === 'negotiating') { hangup(); setWarning(tRef.current.failed); }
    }, 25_000);
  }
  function ringTimeout() {
    clearRing();
    ringTimerRef.current = setTimeout(() => {
      if (phaseRef.current === 'dialing' || phaseRef.current === 'incoming') {
        const wasDialing = phaseRef.current === 'dialing';
        hangup();
        setWarning(wasDialing ? tRef.current.noAnswer : tRef.current.missed);
      }
    }, 30_000);
  }
  function renderStreams() {
    if (localVideoRef.current && localVideoRef.current.srcObject !== localStreamRef.current)
      localVideoRef.current.srcObject = localStreamRef.current;
    for (const el of [remoteVideoRef.current, remoteAudioRef.current])
      if (el && el.srcObject !== remoteStreamRef.current) el.srcObject = remoteStreamRef.current;
  }
  async function flushCandidates(pc: RTCPeerConnection) {
    if (!pc.remoteDescription) return;
    const queued = remoteCandidatesRef.current.splice(0);
    for (const candidate of queued) {
      try { await pc.addIceCandidate(candidate); } catch { /* stale/invalid ICE candidate */ }
    }
  }
  /** Microphone (+ camera for a video call). Camera problems fall back to voice; a missing microphone to receive-only. */
  async function getMedia(want: Media): Promise<MediaStream> {
    const tt = tRef.current;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error(tt.errSecure);
    const audio = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
    if (want === 'video') {
      try {
        return await navigator.mediaDevices.getUserMedia({
          audio, video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 }, facingMode: 'user' },
        });
      } catch (camError) {
        const name = camError instanceof DOMException ? camError.name : '';
        const stream = await getMedia('audio');
        setWarning(name === 'NotAllowedError' ? tt.camDenied : tt.camMissing);
        return stream;
      }
    }
    try { return await navigator.mediaDevices.getUserMedia({ audio, video: false }); }
    catch (micError) {
      const name = micError instanceof DOMException ? micError.name : '';
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
        setWarning(tt.errNoMic);
        return new MediaStream();
      }
      throw new Error(mediaErrorText(tt, micError));
    }
  }
  async function initializePeer(token: number, peerId: string, want: Media, caller: boolean): Promise<RTCPeerConnection | null> {
    if (typeof RTCPeerConnection === 'undefined') throw new Error(tRef.current.errNoRtc);
    const stream = await getMedia(want);
    if (generationRef.current !== token || partnerRef.current?.id !== peerId) {
      stream.getTracks().forEach(track => track.stop());
      return null;
    }
    localStreamRef.current = stream;
    setHasLocalVideo(stream.getVideoTracks().length > 0);
    setCamEnabled(stream.getVideoTracks().some(track => track.enabled));
    setMicEnabled(stream.getAudioTracks().some(track => track.enabled));
    const pc = new RTCPeerConnection(rtcConfigRef.current);
    pcRef.current = pc;
    remoteStreamRef.current = new MediaStream();
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
    // the caller's offer decides the m-lines: still receive what we cannot send (no microphone / camera)
    if (caller) {
      if (!stream.getAudioTracks().length) pc.addTransceiver('audio', { direction: 'recvonly' });
      if (mediaRef.current === 'video' && !stream.getVideoTracks().length) pc.addTransceiver('video', { direction: 'recvonly' });
    }
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && generationRef.current === token)
        transmit({ type: 'rtc:ice', to: peerId, candidate: candidate.toJSON() });
    };
    pc.ontrack = ({ track, streams }) => {
      if (generationRef.current !== token) return;
      if (streams[0]) remoteStreamRef.current = streams[0];
      else if (remoteStreamRef.current && !remoteStreamRef.current.getTracks().includes(track))
        remoteStreamRef.current.addTrack(track);
      setHasRemoteVideo(Boolean(remoteStreamRef.current?.getVideoTracks().length));
      renderStreams();
      track.onunmute = () => { if (generationRef.current === token) renderStreams(); };
    };
    pc.onconnectionstatechange = () => {
      if (generationRef.current !== token) return;
      if (pc.connectionState === 'connected') {
        clearRing();
        if (phaseRef.current !== 'active') {
          move('active');
          setStartedAt(Date.now());
          setAnnounce(`${tRef.current.active} ${partnerRef.current?.name ?? ''}`);
          setMood('happy');
        }
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        transmit({ type: 'call:hangup', to: peerId });
        resetCall(tRef.current.failed);
      }
    };
    renderStreams();
    return pc;
  }
  async function startOffer(peerId: string) {
    const token = generationRef.current;
    try {
      const pc = await initializePeer(token, peerId, mediaRef.current, true);
      if (!pc || generationRef.current !== token) return;
      await pc.setLocalDescription(await pc.createOffer());
      if (generationRef.current === token && pc.localDescription?.sdp)
        transmit({ type: 'rtc:offer', to: peerId, sdp: pc.localDescription.sdp });
    } catch (cause) { failCall(peerId, cause); }
  }
  async function receiveOffer(peerId: string, sdp: string) {
    const token = generationRef.current;
    const pc = pcRef.current;
    if (!pc || partnerRef.current?.id !== peerId || phaseRef.current !== 'negotiating') return;
    try {
      await pc.setRemoteDescription({ type: 'offer', sdp });
      await flushCandidates(pc);
      await pc.setLocalDescription(await pc.createAnswer());
      if (generationRef.current === token && pc.localDescription?.sdp)
        transmit({ type: 'rtc:answer', to: peerId, sdp: pc.localDescription.sdp });
    } catch (cause) { failCall(peerId, cause); }
  }
  async function receiveAnswer(peerId: string, sdp: string) {
    const token = generationRef.current;
    const pc = pcRef.current;
    if (!pc || partnerRef.current?.id !== peerId || phaseRef.current !== 'negotiating') return;
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp });
      if (generationRef.current === token) await flushCandidates(pc);
    } catch (cause) { failCall(peerId, cause); }
  }
  function failCall(peerId: string, cause: unknown) {
    if (partnerRef.current?.id !== peerId) return;
    transmit({ type: 'call:hangup', to: peerId });
    resetCall(cause instanceof Error && cause.message ? cause.message : tRef.current.failed);
  }
  function receive(event: Wire) {
    const tt = tRef.current;
    switch (event.type) {
      case 'welcome':
        selfIdRef.current = event.id;
        if (Array.isArray(event.iceServers)) rtcConfigRef.current = {
          iceServers: event.iceServers, ...(event.iceTransportPolicy === 'relay' ? { iceTransportPolicy: 'relay' as const } : {}),
        };
        setPeers(event.peers);
        retryCountRef.current = 0;
        setWarning('');
        move('ready');
        setMood('greet');
        break;
      case 'peer:joined':
        setPeers(prev => prev.some(p => p.id === event.peer.id) ? prev : [...prev, event.peer]);
        break;
      case 'peer:left':
        setPeers(prev => prev.filter(p => p.id !== event.id));
        if (partnerRef.current?.id === event.id) resetCall(tt.missed);
        break;
      case 'peer:status':
        setPeers(prev => prev.map(p => p.id === event.id ? { ...p, busy: event.busy } : p));
        break;
      case 'call:invite': {
        if (phaseRef.current !== 'ready') {
          transmit({ type: 'call:reject', to: event.from });
          return;
        }
        const media: Media = event.media === 'audio' ? 'audio' : 'video';
        const who: Incoming = { id: event.from, name: event.name, terminal: event.terminal, place: event.place, media };
        mediaRef.current = media;
        setCallMedia(media);
        setPartnerBoth(who);
        setIncoming(who);
        setWarning('');
        move('incoming');
        setMood('listening');
        ringTimeout();
        break;
      }
      case 'call:accept':
        if (phaseRef.current !== 'dialing' || partnerRef.current?.id !== event.from) return;
        clearRing();
        move('negotiating');
        setAnnounce(`${tt.negotiating} ${partnerRef.current?.name ?? ''}`);
        connectionTimeout();
        void startOffer(event.from);
        break;
      case 'call:reject':
      case 'call:cancel':
      case 'call:hangup':
        if (partnerRef.current?.id !== event.from) return;
        resetCall(event.reason === 'busy' ? tt.peerBusy : event.reason === 'declined' ? tt.declined
          : event.type === 'call:hangup' && phaseRef.current === 'active' ? tt.ended : tt.missed);
        break;
      case 'rtc:offer':
        void receiveOffer(event.from, event.sdp);
        break;
      case 'rtc:answer':
        void receiveAnswer(event.from, event.sdp);
        break;
      case 'rtc:ice':
        if (partnerRef.current?.id !== event.from) return;
        if (pcRef.current?.remoteDescription) {
          void pcRef.current.addIceCandidate(event.candidate).catch(() => {});
        } else remoteCandidatesRef.current.push(event.candidate);
        break;
      case 'error': {
        const text = (event.code && tt.codes[event.code]) || tt.signalling;
        if (phaseRef.current === 'connecting' && retryCountRef.current > 0 &&
            (event.code === 'name-taken' || event.code === 'terminal-taken')) {
          // automatic reconnect: the server may still hold our previous, dropped socket until its heartbeat
          // times out, so this is our own name. Close and let the backoff retry instead of opening the form.
          socketRef.current?.close();
        } else if (phaseRef.current === 'connecting') {
          // the server refused the join (name taken, channel full ...): back to the terminal form
          stopSocket();
          setEditing(true);
        } else if (phaseRef.current === 'dialing' && event.code !== 'rate') {
          resetCall();
        }
        setWarning(text);
        break;
      }
    }
  }
  receiveRef.current = receive;

  function openSocket() {
    if (!desiredRef.current) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/crew-video-ws`);
    socketRef.current = socket;
    move('connecting');
    socket.onopen = () => {
      if (socketRef.current === socket) socket.send(JSON.stringify({ type: 'join', ...loginRef.current }));
    };
    socket.onmessage = ({ data }: MessageEvent<string>) => {
      if (socketRef.current !== socket) return;
      let event: Wire;
      try { event = JSON.parse(data) as Wire; } catch { return; /* malformed event */ }
      receiveRef.current(event);
    };
    socket.onclose = () => {
      if (socketRef.current !== socket) return;
      socketRef.current = null;
      generationRef.current++;
      releaseMedia();
      clearRing();
      setIncoming(null);
      setPartnerBoth(null);
      setPeers([]);
      move(desiredRef.current ? 'connecting' : 'offline');
      if (desiredRef.current) {
        const delay = Math.min(1000 * 2 ** retryCountRef.current++, 10_000);
        if (retryCountRef.current > 1) setWarning(tRef.current.serverDown);
        retryTimerRef.current = setTimeout(() => openRef.current(), delay);
      }
    };
    socket.onerror = () => { if (socketRef.current === socket && retryCountRef.current > 0) setWarning(tRef.current.serverDown); };
  }
  openRef.current = openSocket;

  function stopSocket() {
    desiredRef.current = false;
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    if (partnerRef.current) hangup();
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close();
    resetCall();
    setPeers([]);
    move('offline');
  }
  function connectAs(id: Identity, channel: string) {
    if (socketRef.current) stopSocket();
    loginRef.current = { name: id.name, room: channel, terminal: id.terminal, place: id.place };
    desiredRef.current = true;
    retryCountRef.current = 0;
    setWarning('');
    openSocket();
  }

  function saveIdentity(id: Identity, channel: string) {
    setIdentity(id);
    setRoom(channel);
    setEditing(false);
    try { localStorage.setItem(LS_ID, JSON.stringify(id)); localStorage.setItem(LS_ROOM, channel); } catch { /* private mode */ }
    connectAs(id, channel);
  }
  function disconnect() {
    stopSocket();
    setEditing(true);
  }
  function call(person: Person, media: Media) {
    if (phaseRef.current !== 'ready') return;
    unlockAudio();
    setWarning('');
    mediaRef.current = media;
    setCallMedia(media);
    setPartnerBoth(person);
    move('dialing');
    setAnnounce(`${tRef.current.calling} ${person.name}`);
    setMood('talking');
    if (!transmit({ type: 'call:invite', to: person.id, media })) { resetCall(tRef.current.failed); return; }
    ringTimeout();
  }
  async function accept(withCamera: boolean) {
    const person = partnerRef.current;
    if (!person || phaseRef.current !== 'incoming') return;
    unlockAudio();
    clearRing();
    setIncoming(null);
    onOpen?.();
    move('negotiating');
    setAnnounce(`${tRef.current.negotiating} ${person.name}`);
    connectionTimeout();
    const token = generationRef.current;
    const want: Media = withCamera && mediaRef.current === 'video' ? 'video' : 'audio';
    try {
      const pc = await initializePeer(token, person.id, want, false);
      if (pc && generationRef.current === token) transmit({ type: 'call:accept', to: person.id });
    } catch (cause) { failCall(person.id, cause); }
  }
  function toggleMic() {
    const tracks = localStreamRef.current?.getAudioTracks() ?? [];
    if (!tracks.length) return;
    const enabled = !tracks[0].enabled;
    tracks.forEach(track => { track.enabled = enabled; });
    setMicEnabled(enabled);
  }
  function toggleCam() {
    const tracks = localStreamRef.current?.getVideoTracks() ?? [];
    if (!tracks.length) return;
    const enabled = !tracks[0].enabled;
    tracks.forEach(track => { track.enabled = enabled; });
    setCamEnabled(enabled);
  }

  // crew database terminals (assistant server proxy); 404 / 503 / network error -> free-text name
  async function loadTerminals() {
    setTerminals(prev => (Array.isArray(prev) ? prev : 'loading'));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 4000);
    try {
      const r = await fetch('/api/crew/terminals', { signal: ac.signal, headers: { accept: 'application/json' } });
      if (!r.ok) throw new Error(String(r.status));
      const data: unknown = await r.json();
      const rows = Array.isArray(data) ? data.filter((x): x is TerminalRow =>
        !!x && typeof x.code === 'string' && typeof x.room_code === 'string' && typeof x.room_name === 'string') : [];
      setTerminals(rows.length ? rows : null);
    } catch { setTerminals(prev => (Array.isArray(prev) ? prev : null)); }
    finally { clearTimeout(timer); }
  }

  useEffect(() => {
    void loadTerminals();
    const saved = loadIdentity();
    if (saved) connectAs(saved, loadRoom()); // a configured terminal is always reachable
    const unlock = () => unlockAudio();
    addEventListener('pointerdown', unlock, { once: true });
    addEventListener('keydown', unlock, { once: true });
    return () => {
      removeEventListener('pointerdown', unlock);
      removeEventListener('keydown', unlock);
      desiredRef.current = false;
      generationRef.current++;
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
      clearRing();
      stopTone();
      pcRef.current?.close();
      localStreamRef.current?.getTracks().forEach(track => track.stop());
      const socket = socketRef.current;
      socketRef.current = null;
      socket?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // srcObject needs re-attachment when the media elements mount
  useEffect(() => { renderStreams(); }, [phase, hasRemoteVideo, hasLocalVideo, callMedia]);
  // ringing: incoming = two-tone ring + vibration, outgoing = quiet ringback
  useEffect(() => {
    if (phase === 'incoming') startTone('incoming');
    else if (phase === 'dialing') startTone('outgoing');
    else stopTone();
  }, [phase]);
  useEffect(() => {
    if (phase !== 'active') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [phase]);
  useEffect(() => {
    if (mood === 'idle') return;
    const timer = setTimeout(() => setMood('idle'), 2200);
    return () => clearTimeout(timer);
  }, [mood]);
  useEffect(() => {
    if (!announce) return;
    const timer = setTimeout(() => setAnnounce(''), 6000);
    return () => clearTimeout(timer);
  }, [announce]);

  // ---- derived lists ----
  const others = peers.filter(p => p.id !== selfIdRef.current);
  const bridgePeers = others.filter(p => p.place === BRIDGE_ROOM);
  const bridgeTarget = bridgePeers.find(p => !p.busy) ?? bridgePeers[0];
  const selfOnBridge = identity?.place === BRIDGE_ROOM;
  const sortedOnline = useMemo(() => [...others].sort((a, b) =>
    Number(b.place === BRIDGE_ROOM) - Number(a.place === BRIDGE_ROOM) ||
    (a.terminal ?? '~' + a.name).localeCompare(b.terminal ?? '~' + b.name, 'pl')), [others]);
  const offlineTerminals = Array.isArray(terminals)
    ? terminals.filter(row => row.code !== identity?.terminal && !others.some(p => p.terminal === row.code)) : [];
  const elapsed = startedAt ? Math.max(0, Math.round((now - startedAt) / 1000)) : 0;
  const statusText = phase === 'offline' ? t.offline : phase === 'connecting' ? t.connecting : t.online;

  return (
    <div className="crew-video">
      <p className="sr-only" aria-live="polite" aria-atomic="true">{announce}</p>

      <header className="flex items-end gap-3 pb-4">
        <span className="shrink-0" aria-hidden="true"><MewkaReact state={mood} size="md" /></span>
        <div className="min-w-0 flex-1 pb-1">
          <p className="tech-kicker">{t.kicker}</p>
          <h1 className="tech-title mt-1 text-h2">{t.title}</h1>
        </div>
        <span className={`cv-status shrink-0 ${connected ? 'is-on' : phase === 'connecting' ? 'is-wait' : ''}`}>
          <span className="cv-dot" aria-hidden="true" />{statusText}
        </span>
      </header>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)] lg:items-start">
        <div className="flex min-w-0 flex-col gap-4">
          {editing || !identity ? (
            <IdentityForm t={t} terminals={terminals} current={identity} room={room}
                          onReload={() => void loadTerminals()}
                          onCancel={identity ? () => { setEditing(false); if (!socketRef.current) connectAs(identity, room); } : undefined}
                          onSave={saveIdentity} />
          ) : (
            <section className="panel flex flex-wrap items-center gap-3 p-3" aria-label={t.thisTerminal}>
              <span className="cv-badge" aria-hidden="true"><CallIcon name="terminal" /></span>
              <div className="min-w-0 flex-1">
                <p className="tech-kicker">{t.thisTerminal}</p>
                <p className="truncate text-base font-semibold">{identity.name}</p>
                <p className="text-xs text-ink-2">{[identity.terminal, room].filter(Boolean).join(' · ')}</p>
              </div>
              <div className="flex gap-2">
                <button type="button" className="tap cv-btn cv-btn-line" disabled={inCall || phase === 'incoming'}
                        onClick={() => { setEditing(true); void loadTerminals(); }}>{t.change}</button>
              </div>
            </section>
          )}

          {warning && <p role="alert" className="cv-warn">{warning}</p>}

          {identity && !editing && !selfOnBridge && (
            <button type="button" className="tap cv-bridge" disabled={!connected || phase !== 'ready' || !bridgeTarget}
                    onClick={() => bridgeTarget && call(bridgeTarget, 'audio')}>
              <span className="cv-bridge-icon" aria-hidden="true"><CallIcon name="phone" size={26} /></span>
              <span className="min-w-0 text-left">
                <span className="block tech-title text-[1.375rem]">{t.bridge}</span>
                <span className="block text-sm">
                  {!bridgeTarget ? t.bridgeOff : bridgeTarget.busy ? t.bridgeBusy
                    : `${t.bridgeSub}${bridgeTarget.terminal ? ' · ' + bridgeTarget.terminal : ''}`}
                </span>
              </span>
            </button>
          )}
          {identity && !editing && selfOnBridge && <p className="text-sm text-ink-2">{t.bridgeSelf}</p>}

          {inCall && partner && (
            <section className="panel cv-call p-3" aria-label={`${phase === 'active' ? t.active : phase === 'dialing' ? t.calling : t.negotiating} ${partner.name}`}>
              <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
                <div className="min-w-0">
                  <p className="tech-kicker">{phase === 'dialing' ? t.calling : phase === 'negotiating' ? t.negotiating : t.active}</p>
                  <p className="tech-title truncate text-[1.5rem]">{partner.name}</p>
                  {partner.terminal && <p className="text-xs text-ink-2">{partner.terminal}</p>}
                </div>
                <p className="cv-timer tabular-nums">
                  {phase === 'active' ? fmtTime(elapsed) : callMedia === 'audio' ? t.voiceOnly : t.videoFor}
                </p>
              </div>
              {callMedia === 'video' && phase !== 'dialing' ? (
                <div className="cv-stage">
                  <video ref={remoteVideoRef} autoPlay playsInline muted aria-label={`${t.remote}: ${partner.name}`} />
                  {!hasRemoteVideo && <span className="cv-stage-msg">{t.waitingVideo}</span>}
                  {hasLocalVideo && (
                    <div className="cv-pip">
                      <video ref={localVideoRef} autoPlay playsInline muted aria-label={t.local} />
                      <span className="cv-pip-label">{t.local}</span>
                    </div>
                  )}
                </div>
              ) : (
                <div className={`cv-voice ${phase === 'dialing' ? 'is-ringing' : ''}`}>
                  <span className="cv-voice-ring" aria-hidden="true"><CallIcon name={phase === 'dialing' ? 'phone' : 'wave'} size={34} /></span>
                  <span className="text-sm">{phase === 'dialing' ? `${t.calling} ${partner.name}…` : t.voiceOnly}</span>
                </div>
              )}
              <audio ref={remoteAudioRef} autoPlay />
              <div className="cv-controls mt-3">
                {phase !== 'dialing' && (
                  <>
                    <ControlButton icon={micEnabled ? 'mic' : 'mic-off'} pressed={!micEnabled} onClick={toggleMic}
                                   label={micEnabled ? t.micOn : t.micOff} />
                    {hasLocalVideo && (
                      <ControlButton icon={camEnabled ? 'camera' : 'camera-off'} pressed={!camEnabled} onClick={toggleCam}
                                     label={camEnabled ? t.camOn : t.camOff} />
                    )}
                  </>
                )}
                <button type="button" className="tap cv-btn cv-btn-danger cv-ctl" onClick={hangup}>
                  <CallIcon name="hangup" /> <span>{t.end}</span>
                </button>
              </div>
            </section>
          )}
        </div>

        {identity && !editing && (
          <section className="panel min-w-0 p-3" aria-labelledby="cv-terminals-h">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <h2 id="cv-terminals-h" className="tech-title text-[1.25rem]">{t.terminals}</h2>
              <span className="tech-kicker">{t.onlineCount(connected ? others.length + 1 : 0)}</span>
            </div>
            {connected && !others.length && <p className="py-2 text-sm text-ink-2">{t.empty}</p>}
            {!connected && <p className="py-2 text-sm text-ink-2">{statusText}</p>}
            {connected && others.length > 0 && (
              <ul className="cv-list">
                {sortedOnline.map(person => (
                  <li key={person.id} className="cv-row">
                    <span className={`cv-dot ${person.busy ? 'is-busy' : 'is-on'}`} aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">{person.name}</p>
                      <p className="truncate text-xs text-ink-2">
                        {[person.terminal, person.busy ? t.busy : t.available].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <button type="button" className="tap cv-btn cv-btn-line cv-call-btn" disabled={phase !== 'ready'}
                              onClick={() => call(person, 'audio')}
                              aria-label={`${t.voiceFor}: ${person.name}${person.terminal ? ' (' + person.terminal + ')' : ''}`}>
                        <CallIcon name="phone" /><span className="cv-call-txt">{t.voice}</span>
                      </button>
                      <button type="button" className="tap cv-btn cv-btn-ink cv-call-btn" disabled={phase !== 'ready'}
                              onClick={() => call(person, 'video')}
                              aria-label={`${t.videoFor}: ${person.name}${person.terminal ? ' (' + person.terminal + ')' : ''}`}>
                        <CallIcon name="camera" /><span className="cv-call-txt">{t.video}</span>
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {offlineTerminals.length > 0 && (
              <details className="cv-offline mt-3">
                <summary className="tap">{t.offlineList(offlineTerminals.length)}</summary>
                <ul className="cv-list">
                  {offlineTerminals.map(row => (
                    <li key={row.code} className="cv-row is-off">
                      <span className="cv-dot" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate">{row.room_name}</p>
                        <p className="text-xs text-ink-2">{row.code} · {t.offline.toLowerCase()}</p>
                      </div>
                    </li>
                  ))}
                </ul>
              </details>
            )}
            {identity && (
              <button type="button" className="tap cv-btn cv-btn-line mt-3 w-full" onClick={disconnect}
                      disabled={phase === 'offline'}>{t.disconnect}</button>
            )}
          </section>
        )}
      </div>

      <p className="mt-4 text-xs text-ink-2">{t.note}</p>

      {phase === 'incoming' && incoming && createPortal(
        <IncomingDialog t={t} who={incoming} onAccept={(cam) => void accept(cam)} onDecline={hangup} />,
        document.body,
      )}
    </div>
  );
}

function ControlButton({ icon, label, pressed, onClick }: { icon: CallIconName; label: string; pressed: boolean; onClick(): void }) {
  return (
    <button type="button" className={`tap cv-btn cv-ctl ${pressed ? 'cv-btn-warn' : 'cv-btn-line'}`} aria-pressed={pressed} onClick={onClick}>
      <CallIcon name={icon} /> <span>{label}</span>
    </button>
  );
}

/** Modal incoming-call dialog: focus on "Odbierz", Tab stays inside, Escape declines, focus returns afterwards. */
function IncomingDialog({ t, who, onAccept, onDecline }: {
  t: Strings; who: Incoming; onAccept(withCamera: boolean): void; onDecline(): void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const acceptRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    acceptRef.current?.focus();
    return () => { if (before?.isConnected) before.focus(); };
  }, []);
  function onKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') { e.preventDefault(); onDecline(); return; }
    if (e.key !== 'Tab') return;
    const items = [...(boxRef.current?.querySelectorAll<HTMLElement>('button') ?? [])];
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
  const kind = who.media === 'audio' ? t.incomingVoice : t.incomingVideo;
  return (
    <div className="cv-overlay" onKeyDown={onKey}>
      <div ref={boxRef} className="cv-dialog panel" role="alertdialog" aria-modal="true"
           aria-labelledby="cv-in-title" aria-describedby="cv-in-desc">
        <p className="tech-kicker cv-dialog-kicker">
          <span className="cv-ring-dot" aria-hidden="true" />{t.incoming}
        </p>
        <h2 id="cv-in-title" className="tech-title mt-2 text-[2rem]">{who.name}</h2>
        <p id="cv-in-desc" className="mt-1 text-sm text-ink-2">
          {[who.terminal, kind].filter(Boolean).join(' · ')}
        </p>
        <div className="mt-5 grid gap-2">
          <button ref={acceptRef} type="button" className="tap cv-btn cv-btn-ok cv-big" onClick={() => onAccept(true)}>
            <CallIcon name={who.media === 'audio' ? 'phone' : 'camera'} /> <span>{t.accept}</span>
          </button>
          {who.media === 'video' && (
            <button type="button" className="tap cv-btn cv-btn-line cv-big" onClick={() => onAccept(false)}>
              <CallIcon name="phone" /> <span>{t.acceptVoice}</span>
            </button>
          )}
          <button type="button" className="tap cv-btn cv-btn-danger cv-big" onClick={onDecline}>
            <CallIcon name="hangup" /> <span>{t.decline}</span>
          </button>
        </div>
        <p className="mt-3 text-center text-xs text-ink-2" aria-hidden="true">{t.escHint}</p>
      </div>
    </div>
  );
}

/** Terminal picker: crew database list (grouped by deck) or a free-text name; channel under "advanced". */
function IdentityForm({ t, terminals, current, room, onSave, onCancel, onReload }: {
  t: Strings; terminals: TerminalRow[] | null | 'loading'; current: Identity | null; room: string;
  onSave(id: Identity, channel: string): void; onCancel?: () => void; onReload(): void;
}) {
  const list = Array.isArray(terminals) ? terminals : [];
  const [pick, setPick] = useState(() => current?.terminal ?? (current ? '__manual' : ''));
  const [name, setName] = useState(() => (current && !current.terminal ? current.name : ''));
  const [channel, setChannel] = useState(room);
  const [err, setErr] = useState('');
  const manual = !list.length || pick === '__manual';
  const decks = useMemo(() => {
    const m = new Map<string, TerminalRow[]>();
    for (const row of list) {
      const d = deckOf(row.room_code);
      m.set(d, [...(m.get(d) ?? []), row]);
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [list]);

  function submit(e: FormEvent) {
    e.preventDefault();
    const ch = channel.trim().toUpperCase();
    if (!ROOM_RE.test(ch)) { setErr(t.codes.invalid); return; }
    if (manual) {
      const n = name.trim().replace(/\s+/g, ' ');
      if ([...n].length < 2 || [...n].length > 40) { setErr(t.codes.invalid); return; }
      onSave({ name: n }, ch);
      return;
    }
    const row = list.find(r => r.code === pick);
    if (!row) { setErr(t.pickOne); return; }
    onSave({ name: nameFor(row), terminal: row.code, place: row.room_code }, ch);
  }

  return (
    <form className="panel flex flex-col gap-3 p-4" onSubmit={submit} aria-labelledby="cv-setup-h" noValidate>
      <div>
        <h2 id="cv-setup-h" className="tech-title text-[1.375rem]">{t.setupTitle}</h2>
        <p className="mt-1 text-sm text-ink-2">{t.setupIntro}</p>
      </div>
      {terminals === 'loading' && <p role="status" className="text-sm text-ink-2">{t.dbLoading}</p>}
      {terminals === null && (
        <p className="flex flex-wrap items-center gap-2 text-sm text-gold-ink">
          {t.dbDown}
          <button type="button" className="tap cv-btn cv-btn-line" onClick={onReload}>
            {t.retry}
          </button>
        </p>
      )}
      {list.length > 0 && (
        <Field label={t.terminal} id="cv-terminal">
          <select id="cv-terminal" className="tap cv-input" value={pick} onChange={e => { setPick(e.target.value); setErr(''); }}>
            <option value="" disabled>{t.pickOne}</option>
            {decks.map(([deck, rows]) => (
              <optgroup key={deck} label={deck ? t.deck(deck) : '-'}>
                {rows.map(row => <option key={row.code} value={row.code}>{row.room_name} · {row.code}</option>)}
              </optgroup>
            ))}
            <option value="__manual">{t.manual}</option>
          </select>
        </Field>
      )}
      {manual && terminals !== 'loading' && (
        <Field label={t.name} id="cv-name">
          <input id="cv-name" className="tap cv-input" value={name} maxLength={40} autoComplete="off"
                 placeholder={t.namePh} onChange={e => { setName(e.target.value); setErr(''); }} />
        </Field>
      )}
      <details className="cv-adv">
        <summary className="tap">{t.channel}</summary>
        <Field label={t.channelHint} id="cv-channel">
          <input id="cv-channel" className="tap cv-input uppercase" value={channel} maxLength={24} autoComplete="off"
                 spellCheck={false} onChange={e => { setChannel(e.target.value); setErr(''); }} />
        </Field>
      </details>
      {err && <p role="alert" className="cv-warn">{err}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="submit" className="tap cv-btn cv-btn-ink flex-1" disabled={terminals === 'loading'}>{t.save}</button>
        {onCancel && <button type="button" className="tap cv-btn cv-btn-line" onClick={onCancel}>{t.cancel}</button>}
      </div>
    </form>
  );
}

function Field({ label, id, children }: { label: string; id: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-semibold">{label}</label>
      {children}
    </div>
  );
}
