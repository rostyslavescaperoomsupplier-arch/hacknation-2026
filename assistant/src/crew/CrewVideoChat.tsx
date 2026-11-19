/** Crew video calls (WebSocket signaling + browser WebRTC, peer-to-peer media). */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { Lang } from '../types';
import { MewkaReact } from '../../../mewka/src/mewka/MewkaReact';
import type { MewkaState } from '../../../mewka/src';
import './crew-video.css';

type Person = { id: string; name: string };
type Phase = 'offline' | 'connecting' | 'ready' | 'dialing' | 'incoming' | 'negotiating' | 'active';
type Wire =
  | { type: 'welcome'; id: string; room: string; peers: Person[] }
  | { type: 'peer:joined'; peer: Person }
  | { type: 'peer:left'; id: string }
  | { type: 'call:invite'; from: string; name: string }
  | { type: 'call:accept'; from: string }
  | { type: 'call:reject' | 'call:cancel' | 'call:hangup'; from: string; reason?: string }
  | { type: 'rtc:offer' | 'rtc:answer'; from: string; sdp: string }
  | { type: 'rtc:ice'; from: string; candidate: RTCIceCandidateInit }
  | { type: 'error'; message: string };

const langs = {
  pl: {
    title: 'Mewka Crew Video', intro: 'Wideorozmowy dla załogi w sieci statku', open: 'Otwórz wideoczat', close: 'Zwiń',
    name: 'Twoje imię', room: 'Kanał statku', join: 'Dołącz', leave: 'Rozłącz', online: 'Załoga online', you: 'Ty',
    empty: 'Gdy inni członkowie załogi dołączą do kanału, zobaczysz ich tutaj.', call: 'Zadzwoń',
    incoming: 'Połączenie przychodzące', from: 'Dzwoni', accept: 'Odbierz', decline: 'Odrzuć',
    calling: 'Dzwonienie do', negotiating: 'Łączenie z', active: 'Rozmowa z', connecting: 'Łączenie z serwerem…',
    ready: 'Online', disconnected: 'Offline', end: 'Zakończ', micOn: 'Wycisz mikrofon', micOff: 'Włącz mikrofon',
    camOn: 'Wyłącz kamerę', camOff: 'Włącz kamerę', local: 'Ty', remote: 'Rozmówca',
    waitingVideo: 'Oczekiwanie na obraz…', secure: 'Kamera i mikrofon wymagają HTTPS lub localhost.',
    note: 'Wersja demo: kod kanału nie jest hasłem. Nie używaj do komunikacji krytycznej dla bezpieczeństwa.',
    missed: 'Rozmowa została zakończona lub odrzucona.', busy: 'Rozmówca jest zajęty.', failed: 'Nie udało się nawiązać rozmowy.',
    cameraOff: 'Kamera niedostępna — kontynuujemy tylko z dźwiękiem.',
  },
  en: {
    title: 'Mewka Crew Video', intro: 'Crew video calls over the ship network', open: 'Open videochat', close: 'Collapse',
    name: 'Your name', room: 'Ship channel', join: 'Join', leave: 'Disconnect', online: 'Online crew', you: 'You',
    empty: 'When other crew members join this channel, they will appear here.', call: 'Call',
    incoming: 'Incoming video call', from: 'Calling', accept: 'Answer', decline: 'Decline',
    calling: 'Calling', negotiating: 'Connecting to', active: 'In a call with', connecting: 'Connecting to server…',
    ready: 'Online', disconnected: 'Offline', end: 'Hang up', micOn: 'Mute microphone', micOff: 'Unmute microphone',
    camOn: 'Turn camera off', camOff: 'Turn camera on', local: 'You', remote: 'Crew member',
    waitingVideo: 'Waiting for video…', secure: 'Camera and microphone require HTTPS or localhost.',
    note: 'Hackathon demo: channel codes are not passwords. Not for safety-critical ship communications.',
    missed: 'Call ended or declined.', busy: 'Crew member is busy.', failed: 'Could not establish the call.',
    cameraOff: 'Camera unavailable — continuing with audio only.',
  },
  de: {
    title: 'Mewka Crew Video', intro: 'Videoanrufe über das Schiffsnetz', open: 'Videochat öffnen', close: 'Minimieren',
    name: 'Dein Name', room: 'Schiffskanal', join: 'Beitreten', leave: 'Trennen', online: 'Crew online', you: 'Du',
    empty: 'Andere Crewmitglieder erscheinen hier, sobald sie dem Kanal beitreten.', call: 'Anrufen',
    incoming: 'Eingehender Videoanruf', from: 'Anruf von', accept: 'Annehmen', decline: 'Ablehnen',
    calling: 'Anruf bei', negotiating: 'Verbinden mit', active: 'Im Gespräch mit', connecting: 'Serververbindung…',
    ready: 'Online', disconnected: 'Offline', end: 'Auflegen', micOn: 'Mikrofon stummschalten', micOff: 'Mikrofon einschalten',
    camOn: 'Kamera ausschalten', camOff: 'Kamera einschalten', local: 'Du', remote: 'Crewmitglied',
    waitingVideo: 'Warte auf Video…', secure: 'Kamera und Mikrofon benötigen HTTPS oder localhost.',
    note: 'Hackathon-Demo: Kanalkennung ist kein Passwort. Nicht für sicherheitskritische Schiffskommunikation.',
    missed: 'Anruf beendet oder abgelehnt.', busy: 'Teilnehmer ist beschäftigt.', failed: 'Anruf konnte nicht aufgebaut werden.',
    cameraOff: 'Kamera nicht verfügbar — nur Audio.',
  },
  uk: {
    title: 'Mewka Crew Video', intro: 'Відеодзвінки екіпажу в мережі судна', open: 'Відкрити відеочат', close: 'Згорнути',
    name: 'Твоє імʼя', room: 'Канал судна', join: 'Приєднатися', leave: 'Відʼєднатися', online: 'Екіпаж онлайн', you: 'Ти',
    empty: 'Коли інші члени екіпажу приєднаються до каналу, вони зʼявляться тут.', call: 'Подзвонити',
    incoming: 'Вхідний відеодзвінок', from: 'Дзвонить', accept: 'Прийняти', decline: 'Відхилити',
    calling: 'Дзвінок до', negotiating: 'Зʼєднання з', active: 'Розмова з', connecting: 'Підключення до сервера…',
    ready: 'Онлайн', disconnected: 'Офлайн', end: 'Завершити', micOn: 'Вимкнути мікрофон', micOff: 'Увімкнути мікрофон',
    camOn: 'Вимкнути камеру', camOff: 'Увімкнути камеру', local: 'Ти', remote: 'Співрозмовник',
    waitingVideo: 'Очікування відео…', secure: 'Камера й мікрофон працюють лише через HTTPS або localhost.',
    note: 'Демо хакатону: код каналу не є паролем. Не для критично важливого звʼязку.',
    missed: 'Дзвінок завершився або його відхилили.', busy: 'Співрозмовник зайнятий.', failed: 'Не вдалося встановити звʼязок.',
    cameraOff: 'Камера недоступна — лише аудіо.',
  },
} satisfies Record<Lang, Record<string, string>>;

function rtcServers(): RTCIceServer[] {
  // For an offline ship LAN, start with host ICE candidates only. On separated
  // networks add a self-hosted TURN server via the optional env setting.
  const value = import.meta.env.VITE_CREW_ICE_SERVERS as string | undefined;
  if (!value) return [];
  try { const parsed: unknown = JSON.parse(value); return Array.isArray(parsed) ? parsed as RTCIceServer[] : []; }
  catch { return []; }
}

export default function CrewVideoChat({ lang }: { lang: Lang }) {
  const t = langs[lang];
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState(() => { try { return localStorage.getItem('crew-name') || ''; } catch { return ''; } });
  const [room, setRoom] = useState(() => { try { return localStorage.getItem('crew-room') || 'CREW-01'; } catch { return 'CREW-01'; } });
  const [phase, setPhase] = useState<Phase>('offline');
  const [peers, setPeers] = useState<Person[]>([]);
  const [incoming, setIncoming] = useState<Person | null>(null);
  const [partner, setPartner] = useState<Person | null>(null);
  const [warning, setWarning] = useState('');
  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);
  const [hasRemoteVideo, setHasRemoteVideo] = useState(false);
  const [mood, setMood] = useState<MewkaState>('idle');

  const socketRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const phaseRef = useRef<Phase>('offline');
  const partnerRef = useRef<Person | null>(null);
  const desiredRef = useRef(false);
  const loginRef = useRef({ name: '', room: '' });
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ringTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);
  const retryCountRef = useRef(0);
  const openRef = useRef<() => void>(() => {});

  const connected = phase !== 'offline' && phase !== 'connecting';
  const inCallUI = phase === 'dialing' || phase === 'incoming' || phase === 'negotiating' || phase === 'active';

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
    if (localVideoRef.current) localVideoRef.current.srcObject = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    remoteCandidatesRef.current = [];
    setHasRemoteVideo(false);
    setMicEnabled(true);
    setCamEnabled(true);
  }
  function resetCall(message = '') {
    generationRef.current++;
    clearRing();
    releaseMedia();
    setIncoming(null);
    setPartnerBoth(null);
    setWarning(message);
    move(desiredRef.current && socketRef.current?.readyState === WebSocket.OPEN ? 'ready' : 'offline');
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
      if (phaseRef.current === 'negotiating') {
        hangup();
        setWarning(t.failed);
      }
    }, 25_000);
  }
  function ringTimeout() {
    clearRing();
    ringTimerRef.current = setTimeout(() => {
      if (phaseRef.current === 'dialing' || phaseRef.current === 'incoming') {
        hangup();
        setWarning(t.missed);
      }
    }, 30_000);
  }
  function renderStreams() {
    if (localVideoRef.current && localVideoRef.current.srcObject !== localStreamRef.current)
      localVideoRef.current.srcObject = localStreamRef.current;
    if (remoteVideoRef.current && remoteVideoRef.current.srcObject !== remoteStreamRef.current)
      remoteVideoRef.current.srcObject = remoteStreamRef.current;
  }
  async function flushCandidates(pc: RTCPeerConnection) {
    if (!pc.remoteDescription) return;
    const queued = remoteCandidatesRef.current.splice(0);
    for (const candidate of queued) {
      try { await pc.addIceCandidate(candidate); } catch { /* stale/invalid ICE candidate */ }
    }
  }
  async function initializePeer(token: number, peerId: string): Promise<RTCPeerConnection | null> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error(t.secure);
    if (typeof RTCPeerConnection === 'undefined') throw new Error('WebRTC is not supported in this browser.');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24, max: 30 } },
      });
    } catch (initialError) {
      // A workstation without a webcam should still support voice calls.
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
      catch { throw initialError; }
      setWarning(t.cameraOff);
    }
    if (generationRef.current !== token || partnerRef.current?.id !== peerId) {
      stream.getTracks().forEach(track => track.stop());
      return null;
    }
    localStreamRef.current = stream;
    setCamEnabled(stream.getVideoTracks().some(track => track.enabled));
    setMicEnabled(stream.getAudioTracks().some(track => track.enabled));
    const pc = new RTCPeerConnection({ iceServers: rtcServers() });
    pcRef.current = pc;
    remoteStreamRef.current = new MediaStream();
    for (const track of stream.getTracks()) pc.addTrack(track, stream);
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
      if (pc.connectionState === 'connected') { clearRing(); move('active'); setMood('happy'); }
      else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        transmit({ type: 'call:hangup', to: peerId });
        resetCall(t.failed);
      }
    };
    renderStreams();
    return pc;
  }
  async function startOffer(peerId: string) {
    const token = generationRef.current;
    try {
      const pc = await initializePeer(token, peerId);
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
    resetCall(cause instanceof Error ? cause.message : t.failed);
  }
  function receive(event: Wire) {
    switch (event.type) {
      case 'welcome':
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
        if (partnerRef.current?.id === event.id) resetCall(t.missed);
        break;
      case 'call:invite':
        if (phaseRef.current !== 'ready') {
          transmit({ type: 'call:reject', to: event.from });
          return;
        }
        setPartnerBoth({ id: event.from, name: event.name });
        setIncoming({ id: event.from, name: event.name });
        move('incoming');
        setMood('listening');
        ringTimeout();
        break;
      case 'call:accept':
        if (phaseRef.current !== 'dialing' || partnerRef.current?.id !== event.from) return;
        clearRing();
        move('negotiating');
        connectionTimeout();
        void startOffer(event.from);
        break;
      case 'call:reject':
      case 'call:cancel':
      case 'call:hangup':
        if (partnerRef.current?.id !== event.from) return;
        resetCall(event.reason === 'busy' ? t.busy : t.missed);
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
      case 'error':
        setWarning(event.message);
        break;
    }
  }
  function openSocket() {
    if (!desiredRef.current) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}/crew-video-ws`);
    socketRef.current = socket;
    move('connecting');
    socket.onopen = () => {
      if (socketRef.current === socket)
        socket.send(JSON.stringify({ type: 'join', ...loginRef.current }));
    };
    socket.onmessage = ({ data }: MessageEvent<string>) => {
      if (socketRef.current !== socket) return;
      try { receive(JSON.parse(data) as Wire); } catch { /* malformed event */ }
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
        retryTimerRef.current = setTimeout(() => openRef.current(), delay);
      }
    };
    socket.onerror = () => { if (socketRef.current === socket) setWarning('WebSocket: cannot reach the ship server.'); };
  }
  openRef.current = openSocket;

  function join(event: FormEvent) {
    event.preventDefault();
    const n = name.trim();
    const r = room.trim().toUpperCase();
    if (n.length < 2 || n.length > 40 || !/^[A-Z0-9_-]{3,24}$/.test(r)) {
      setWarning('Name: 2–40 characters. Channel: 3–24 characters (A-Z, 0-9, - or _).');
      return;
    }
    loginRef.current = { name: n, room: r };
    try { localStorage.setItem('crew-name', n); localStorage.setItem('crew-room', r); } catch { /* private browsing */ }
    desiredRef.current = true;
    retryCountRef.current = 0;
    setWarning('');
    openSocket();
    setExpanded(true);
  }
  function disconnect() {
    desiredRef.current = false;
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    if (partnerRef.current) hangup();
    socketRef.current?.close();
    socketRef.current = null;
    resetCall();
    setPeers([]);
    move('offline');
  }
  function call(person: Person) {
    if (phaseRef.current !== 'ready') return;
    setWarning('');
    setPartnerBoth(person);
    move('dialing');
    setMood('talking');
    if (!transmit({ type: 'call:invite', to: person.id })) {
      resetCall(t.failed);
      return;
    }
    ringTimeout();
  }
  async function accept() {
    const person = partnerRef.current;
    if (!person || phaseRef.current !== 'incoming') return;
    clearRing();
    setIncoming(null);
    move('negotiating');
    connectionTimeout();
    const token = generationRef.current;
    try {
      const pc = await initializePeer(token, person.id);
      if (pc && generationRef.current === token)
        transmit({ type: 'call:accept', to: person.id });
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
  // srcObject needs re-attachment when the video element first mounts.
  useEffect(() => { renderStreams(); }, [phase, expanded]);
  useEffect(() => {
    if (mood === 'idle') return;
    const timer = setTimeout(() => setMood('idle'), 2200);
    return () => clearTimeout(timer);
  }, [mood]);
  useEffect(() => () => {
    desiredRef.current = false;
    generationRef.current++;
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    clearRing();
    pcRef.current?.close();
    localStreamRef.current?.getTracks().forEach(track => track.stop());
    const socket = socketRef.current;
    socketRef.current = null;
    socket?.close();
  }, []);

  return (
    <section className="crew-video rounded-xl border border-line bg-paper-2 p-4" aria-label={t.title}>
      <button className="tap flex w-full items-center justify-between gap-3 text-left" type="button"
              aria-expanded={expanded} disabled={inCallUI} onClick={() => setExpanded(prev => !prev)}>
        <span className="flex min-w-0 items-center gap-3">
          <MewkaReact state={mood} size="md" />
          <span><strong className="block font-semibold">{t.title}</strong><span className="block text-sm text-ink-2">{t.intro}</span></span>
        </span>
        <span className="shrink-0 text-xs font-semibold text-gold-ink">
          <span aria-hidden="true">{connected ? '●' : '○'} </span>
          {expanded ? t.close : t.open}
        </span>
      </button>
      {expanded && (
        <div className="mt-4 space-y-4 border-t border-line pt-4">
          {phase === 'offline' && (
            <form className="flex flex-wrap items-end gap-3" onSubmit={join}>
              <label className="flex min-w-36 flex-1 flex-col gap-1 text-sm">{t.name}
                <input className="tap rounded-lg border border-ink/40 bg-paper px-3" value={name}
                       onChange={e => setName(e.target.value)} maxLength={40} required autoComplete="nickname" />
              </label>
              <label className="flex min-w-36 flex-1 flex-col gap-1 text-sm">{t.room}
                <input className="tap rounded-lg border border-ink/40 bg-paper px-3" value={room}
                       onChange={e => setRoom(e.target.value)} maxLength={24} required />
              </label>
              <button type="submit" className="tap rounded-lg bg-ink px-5 font-semibold text-paper">{t.join}</button>
            </form>
          )}
          {phase !== 'offline' && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-ink-2">{loginRef.current.room} · {phase === 'connecting' ? t.connecting : t.ready}</span>
              <button className="tap rounded-lg border border-ink/40 px-3" type="button" onClick={disconnect}>{t.leave}</button>
            </div>
          )}
          {warning && <p role="alert" className="text-sm text-warn">{warning}</p>}
          {connected && (
            <div>
              <h3 className="mb-2 text-sm font-semibold">{t.online} ({peers.length + 1})</h3>
              <div className="flex flex-wrap gap-2">
                <span className="crew-chip">● {loginRef.current.name} ({t.you})</span>
                {peers.map(person => (
                  <div key={person.id} className="crew-chip gap-2">
                    <span>● {person.name}</span>
                    <button type="button" disabled={phase !== 'ready'} onClick={() => call(person)}
                            className="tap crew-call-action rounded-lg bg-ink px-3 text-paper disabled:opacity-40"
                            aria-label={`${t.call}: ${person.name}`}>📹 {t.call}</button>
                  </div>
                ))}
              </div>
              {!peers.length && <p className="mt-3 text-sm text-ink-2">{t.empty}</p>}
            </div>
          )}
          {phase === 'incoming' && incoming && (
            <div className="crew-call-alert" role="status">
              <strong>{t.incoming}</strong>
              <p className="mt-1">{t.from}: {incoming.name}</p>
              <div className="mt-3 flex gap-2">
                <button className="tap rounded-lg bg-ink px-4 font-semibold text-paper" onClick={() => void accept()} type="button">{t.accept}</button>
                <button className="tap rounded-lg border border-ink/40 px-4" onClick={hangup} type="button">{t.decline}</button>
              </div>
            </div>
          )}
          {inCallUI && phase !== 'incoming' && (
            <div className="space-y-3">
              <p className="text-sm font-medium" role="status">
                {phase === 'dialing' ? t.calling : phase === 'negotiating' ? t.negotiating : t.active}: {partner?.name}
              </p>
              {(phase === 'negotiating' || phase === 'active') && (
                <div className="crew-videos">
                  <div className="crew-video-frame">
                    <video ref={remoteVideoRef} autoPlay playsInline aria-label={t.remote} />
                    {!hasRemoteVideo && <span className="crew-video-placeholder">{t.waitingVideo}</span>}
                    <span className="crew-video-label">{partner?.name ?? t.remote}</span>
                  </div>
                  <div className="crew-video-frame crew-video-local">
                    <video ref={localVideoRef} autoPlay playsInline muted aria-label={t.local} />
                    <span className="crew-video-label">{t.local}</span>
                  </div>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                {(phase === 'negotiating' || phase === 'active') && (
                  <>
                    <button className="tap rounded-lg border border-ink/40 px-4 text-sm" type="button"
                            onClick={toggleMic} aria-pressed={!micEnabled}>
                      {micEnabled ? '🎙 ' + t.micOn : '🔇 ' + t.micOff}
                    </button>
                    <button className="tap rounded-lg border border-ink/40 px-4 text-sm" type="button"
                            disabled={!localStreamRef.current?.getVideoTracks().length}
                            onClick={toggleCam} aria-pressed={!camEnabled}>
                      {camEnabled ? '📷 ' + t.camOn : '📷 ' + t.camOff}
                    </button>
                  </>
                )}
                <button className="tap rounded-lg bg-red-700 px-4 font-semibold text-white" type="button" onClick={hangup}>✕ {t.end}</button>
              </div>
            </div>
          )}
          <p className="text-xs text-ink-2">{t.note}</p>
        </div>
      )}
    </section>
  );
}
