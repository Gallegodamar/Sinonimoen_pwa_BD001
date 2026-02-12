
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { LEVEL_DATA } from './data';
import { WordData, Player, Question, GameStatus, DifficultyLevel } from './types';
import { supabase } from './supabase';

const QUESTIONS_PER_PLAYER = 10;

const shuffleArray = <T,>(array: T[]): T[] => {
  const newArr = [...array];
  for (let i = newArr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArr[i], newArr[j]] = [newArr[j], newArr[i]];
  }
  return newArr;
};

const getWordType = (word: string): string => {
  const normalized = word.toLowerCase().trim();
  if (normalized.endsWith('tu') || normalized.endsWith('du') || normalized.endsWith('ten') || normalized.endsWith('tzen')) return 'verb';
  if (normalized.endsWith('ak') || normalized.endsWith('ek')) return 'plural';
  if (normalized.endsWith('era') || normalized.endsWith('ura') || normalized.endsWith('tasun')) return 'abstract';
  return 'other';
};

const App: React.FC = () => {
  const [status, setStatus] = useState<GameStatus>(GameStatus.SETUP);
  const [difficulty, setDifficulty] = useState<DifficultyLevel>(1);
  const [numPlayers, setNumPlayers] = useState(2);
  const [players, setPlayers] = useState<Player[]>([]);
  
  const [questionPool, setQuestionPool] = useState<Question[]>([]);
  const [currentPlayerIndex, setCurrentPlayerIndex] = useState(0);
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  
  const [selectedAnswer, setSelectedAnswer] = useState<string | null>(null);
  const [isAnswered, setIsAnswered] = useState(false);
  
  const [currentTurnPenalties, setCurrentTurnPenalties] = useState(0);
  const turnStartTimeRef = useRef<number>(0);

  // Auth, Search & History States
  const [user, setUser] = useState<any>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  
  const [activeTab, setActiveTab] = useState<'bilatu' | 'historia'>('bilatu');
  const [historySubTab, setHistorySubTab] = useState<'gaur' | 'datuak' | 'hutsak'>('gaur');
  const [failedWordsLevel, setFailedWordsLevel] = useState<DifficultyLevel>(1);
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<(WordData & { level: number })[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
  const [failedWordsStats, setFailedWordsStats] = useState<any[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  // History filtering states
  const [searchDate, setSearchDate] = useState<string>(new Date().toISOString().split('T')[0]);

  const [wordsByLevel, setWordsByLevel] = useState<Record<number, WordData[]>>({});
  const [isLoadingWords, setIsLoadingWords] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (user && activeTab === 'historia') {
      fetchHistory();
      refreshFailedStats();
    }
  }, [user, activeTab]);

  useEffect(() => {
    if (status === GameStatus.SETUP) {
      setPlayers(Array.from({ length: numPlayers }, (_, i) => ({ 
        id: i, 
        name: `Jokalaria ${i + 1}`, 
        score: 0, 
        time: 0 
      })));
    }
  }, [numPlayers, status]);

  // Search Logic
  useEffect(() => {
    const performSearch = async () => {
      if (!searchTerm || searchTerm.length < 2) {
        setSearchResults([]);
        return;
      }
      setIsSearching(true);
      
      const { data, error } = await supabase
        .from("syn_words")
        .select("source_id, hitza, sinonimoak, level")
        .or(`hitza.ilike.%${searchTerm}%,sinonimoak::text.ilike.%${searchTerm}%`)
        .eq("active", true)
        .limit(50);

      if (!error && data) {
        setSearchResults(data.map((r: any) => ({
          id: r.source_id,
          hitza: r.hitza,
          sinonimoak: Array.isArray(r.sinonimoak) ? r.sinonimoak : [],
          level: r.level
        })));
      }
      setIsSearching(false);
    };

    const timer = setTimeout(performSearch, 350);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  const fetchWordsFromSupabase = async (level: DifficultyLevel): Promise<WordData[]> => {
    const { data, error } = await supabase
      .from("syn_words")
      .select("source_id, hitza, sinonimoak")
      .eq("level", level)
      .eq("active", true);

    if (error) return [];
    return (data ?? []).map((r: any) => ({
      id: r.source_id,
      hitza: r.hitza,
      sinonimoak: Array.isArray(r.sinonimoak) ? r.sinonimoak : [],
    }));
  };

  const ensureLevelWords = async (level: DifficultyLevel) => {
    if (wordsByLevel[level]?.length) return wordsByLevel[level];
    setIsLoadingWords(true);
    const words = await fetchWordsFromSupabase(level);
    setWordsByLevel(prev => ({ ...prev, [level]: words }));
    setIsLoadingWords(false);
    return words;
  };

  const fetchHistory = async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from('game_runs')
      .select('id, played_at, difficulty, total, correct, wrong, time_seconds')
      .eq('user_id', user.id)
      .order('played_at', { ascending: false });
    
    if (!error && data) setHistory(data);
  };

  const fetchMostFailedWords = async () => {
    if (!user) return [];

    const { data, error } = await supabase
      .from("game_answers")
      .select("source_id, hitza, is_correct, level")
      .eq("user_id", user.id);

    if (error) return [];

    // Grouping stats by source_id AND level
    const stats = new Map<string, { hitza: string; wrong: number; attempts: number; level: number }>();
    for (const r of data ?? []) {
      const key = `${r.source_id}_${r.level}`;
      const cur = stats.get(key) || { hitza: r.hitza, wrong: 0, attempts: 0, level: r.level };
      cur.attempts += 1;
      if (!r.is_correct) cur.wrong += 1;
      stats.set(key, cur);
    }

    // Filter by attempts > 1 and return
    return Array.from(stats.entries())
      .map(([key, v]) => ({ 
        source_id: key.split('_')[0], 
        ...v, 
        wrong_rate: v.attempts > 0 ? (v.wrong / v.attempts) * 100 : 0 
      }))
      .filter(v => v.attempts > 1); // Only words seen more than once
  };

  const refreshFailedStats = async () => {
    const stats = await fetchMostFailedWords();
    setFailedWordsStats(stats);
  };

  const generatePoolFromData = (
    needed: number,
    poolSource: WordData[],
    statsMap?: Map<string, { wrong: number; attempts: number }>
  ) => {
    const pickWeighted = () => {
      if (!statsMap || statsMap.size === 0) {
        return poolSource[Math.floor(Math.random() * poolSource.length)];
      }

      const weights = poolSource.map((w) => {
        const s = statsMap.get(String(w.id));
        const wrong = s?.wrong ?? 0;
        const attempts = s?.attempts ?? 0;
        const weight = 1 + wrong * 2 + (attempts > 0 ? (wrong / attempts) * 3 : 0);
        return Math.max(1, weight);
      });

      const totalWeight = weights.reduce((a, b) => a + b, 0);
      let r = Math.random() * totalWeight;
      for (let i = 0; i < poolSource.length; i++) {
        r -= weights[i];
        if (r <= 0) return poolSource[i];
      }
      return poolSource[poolSource.length - 1];
    };

    let gameData: WordData[] = [];
    while (gameData.length < needed) {
      gameData.push(pickWeighted());
    }

    const allWordsInPool = poolSource.flatMap((d) => [d.hitza, ...d.sinonimoak]);
    return gameData.map((data) => {
      const correctAnswer = data.sinonimoak[Math.floor(Math.random() * data.sinonimoak.length)];
      const targetType = getWordType(data.hitza);
      const distractorsPool = allWordsInPool.filter((w) => w !== data.hitza && !data.sinonimoak.includes(w));
      const sameTypeDistractors = distractorsPool.filter((w) => getWordType(w) === targetType);
      const shuffledDistractors = shuffleArray(Array.from(new Set(sameTypeDistractors.length >= 10 ? sameTypeDistractors : distractorsPool))).slice(0, 3);
      const options = shuffleArray([correctAnswer, ...shuffledDistractors]);
      return { wordData: data, correctAnswer, options };
    });
  };

  const startNewGame = useCallback(async (isSolo: boolean = false) => {
    setIsLoadingWords(true);
    if (isSolo && user) {
      const displayName = user.email?.split('@')[0].toUpperCase() || 'NI';
      setPlayers([{ id: 0, name: displayName, score: 0, time: 0 }]);
    }
    const totalNeeded = (isSolo ? 1 : players.length) * QUESTIONS_PER_PLAYER;
    const poolSource = await ensureLevelWords(difficulty);
    if (!poolSource.length) {
      setIsLoadingWords(false);
      alert("Ez da hitzik aurkitu maila honetan.");
      return;
    }

    let statsMap: Map<string, any> | undefined;
    if (user) {
      const failed = await fetchMostFailedWords();
      statsMap = new Map(failed.map(f => [f.source_id, { wrong: f.wrong, attempts: f.attempts }]));
    }

    const newPool = generatePoolFromData(totalNeeded, poolSource, statsMap);
    setQuestionPool(newPool);
    setCurrentPlayerIndex(0);
    setCurrentQuestionIndex(0);
    setIsLoadingWords(false);
    setStatus(GameStatus.INTERMISSION);
  }, [players.length, difficulty, user, wordsByLevel]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    const email = username.includes('@') ? username : `${username}@tuapp.local`;
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setAuthError("ID edo pasahitz okerra");
    else setStatus(GameStatus.CONTRIBUTE);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setStatus(GameStatus.SETUP);
  };

  const startPlayerTurn = () => {
    turnStartTimeRef.current = Date.now();
    setCurrentTurnPenalties(0);
    setStatus(GameStatus.PLAYING);
    setCurrentQuestionIndex(0);
    setIsAnswered(false);
    setSelectedAnswer(null);
  };

  const handlePlayerNameChange = (id: number, name: string) => {
    setPlayers(prev => prev.map(p => (p.id === id ? { ...p, name } : p)));
  };

  const handleAnswer = async (answer: string) => {
    if (isAnswered) return;
    const poolIdx = currentPlayerIndex * QUESTIONS_PER_PLAYER + currentQuestionIndex;
    const currentQuestion = poolIdx >= 0 && poolIdx < questionPool.length ? questionPool[poolIdx] : null;
    if (!currentQuestion) return;

    const isCorrect = answer === currentQuestion.correctAnswer;
    setSelectedAnswer(answer);
    setIsAnswered(true);

    if (user) {
      await supabase.from("game_answers").insert({
        user_id: user.id,
        level: difficulty,
        source_id: currentQuestion.wordData.id,
        hitza: currentQuestion.wordData.hitza,
        chosen: answer,
        correct: currentQuestion.correctAnswer,
        is_correct: isCorrect,
      });
    }

    if (isCorrect) {
      setPlayers(prev => prev.map((p, idx) => idx === currentPlayerIndex ? { ...p, score: p.score + 1 } : p));
    } else {
      setCurrentTurnPenalties(prev => prev + 10);
    }
  };

  const nextQuestion = () => {
    if (currentQuestionIndex < QUESTIONS_PER_PLAYER - 1) {
      setCurrentQuestionIndex(prev => prev + 1);
      setIsAnswered(false);
      setSelectedAnswer(null);
    } else {
      finishPlayerTurn();
    }
  };

  const saveToSupabase = async (player: Player) => {
    if (!user) return;
    setIsSaving(true);
    await supabase.from('game_runs').insert({
      user_id: user.id,
      played_at: new Date().toISOString(),
      difficulty: difficulty,
      total: QUESTIONS_PER_PLAYER,
      correct: player.score,
      wrong: QUESTIONS_PER_PLAYER - player.score,
      time_seconds: player.time,
    });
    setIsSaving(false);
    fetchHistory();
    refreshFailedStats();
  };

  const finishPlayerTurn = async () => {
    const endTime = Date.now();
    const realSeconds = (endTime - turnStartTimeRef.current) / 1000;
    const totalSecondsWithPenalty = realSeconds + currentTurnPenalties;
    const updatedPlayers = players.map((p, idx) => idx === currentPlayerIndex ? { ...p, time: totalSecondsWithPenalty } : p);
    setPlayers(updatedPlayers);

    if (currentPlayerIndex < players.length - 1) {
      setCurrentPlayerIndex(prev => prev + 1);
      setStatus(GameStatus.INTERMISSION);
    } else {
      if (user && players.length === 1) await saveToSupabase(updatedPlayers[0]);
      setStatus(GameStatus.SUMMARY);
    }
  };

  const playedWordData = useMemo(() => {
    return Array.from(new Map<string, WordData>(questionPool.map(q => [q.wordData.hitza, q.wordData])).values())
      .sort((a, b) => a.hitza.localeCompare(b.hitza));
  }, [questionPool]);

  const historyByDateAndLevel = useMemo(() => {
    const todayStr = new Date().toISOString().split('T')[0];
    const statsForDate = (dateStr: string) => {
      const items = history.filter(h => h.played_at.startsWith(dateStr));
      return [1, 2, 3, 4].map(lvl => {
        const lvlItems = items.filter(h => h.difficulty === lvl);
        const totalWords = lvlItems.reduce((acc, h) => acc + h.total, 0);
        const totalCorrect = lvlItems.reduce((acc, h) => acc + h.correct, 0);
        return {
          level: lvl,
          words: totalWords,
          correct: totalCorrect,
          wrong: totalWords - totalCorrect,
          percentage: totalWords > 0 ? (totalCorrect / totalWords) * 100 : 0,
          sessions: lvlItems.length
        };
      }).filter(s => s.sessions > 0);
    };
    return {
      todayItems: history.filter(h => h.played_at.startsWith(todayStr)),
      searchedStats: statsForDate(searchDate),
      searchDateStr: searchDate
    };
  }, [history, searchDate]);

  // Top 10 failed words for the currently selected level in the failures tab
  const filteredFailedStats = useMemo(() => {
    return failedWordsStats
      .filter(s => s.level === failedWordsLevel)
      .sort((a, b) => b.wrong_rate - a.wrong_rate)
      .slice(0, 10);
  }, [failedWordsStats, failedWordsLevel]);

  if (status === GameStatus.AUTH) {
    return (
      <div className="h-[100dvh] w-full flex flex-col items-center justify-center bg-indigo-950 p-6">
        <div className="bg-white w-full max-w-md rounded-[2.5rem] shadow-2xl p-8 border-b-8 border-indigo-600">
          <button onClick={() => setStatus(GameStatus.SETUP)} className="mb-4 text-xs font-black text-slate-400 uppercase tracking-widest">← Atzera</button>
          <h2 className="text-3xl font-black text-indigo-950 mb-1 uppercase tracking-tighter">Logina</h2>
          <p className="text-[10px] font-bold text-slate-400 mb-6 uppercase tracking-widest">Sartu zure erabiltzaile IDa</p>
          <form onSubmit={handleLogin} className="space-y-4">
            <input type="text" placeholder="Erabiltzaile ID" value={username} onChange={e => setUsername(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-4 font-bold text-slate-800" required />
            <input type="password" placeholder="Pasahitza" value={password} onChange={e => setPassword(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-4 font-bold text-slate-800" required />
            {authError && <p className="text-rose-500 text-xs font-bold text-center">{authError}</p>}
            <button type="submit" className="w-full bg-indigo-600 text-white font-black py-5 rounded-2xl shadow-lg active:scale-95 transition-all text-lg uppercase tracking-widest">SARTU</button>
          </form>
        </div>
      </div>
    );
  }

  if (status === GameStatus.CONTRIBUTE) {
    const levelColors = {
      1: 'bg-sky-50 text-sky-600 border-sky-100',
      2: 'bg-emerald-50 text-emerald-600 border-emerald-100',
      3: 'bg-amber-50 text-amber-600 border-amber-100',
      4: 'bg-rose-50 text-rose-600 border-rose-100'
    };

    return (
      <div className="h-[100dvh] w-full flex flex-col items-center bg-indigo-950 safe-pt safe-px overflow-hidden">
        <div className="bg-white w-full max-w-2xl rounded-[2.5rem] shadow-2xl p-6 md:p-8 flex flex-col h-full max-h-[92dvh] mb-4">
          <div className="flex justify-between items-center mb-6 shrink-0">
            <button onClick={() => setStatus(GameStatus.SETUP)} className="text-xs font-black text-slate-400 uppercase tracking-widest">← Hasiera</button>
            <div className="flex flex-col items-center">
              <h2 className="text-xl font-black text-indigo-950 uppercase tracking-tight">Arbela</h2>
              <span className="text-[9px] font-black text-indigo-400 uppercase">{user?.email?.split('@')[0]}</span>
            </div>
            <button onClick={handleLogout} className="bg-slate-100 text-slate-500 px-4 py-2 rounded-xl text-[10px] font-black uppercase">Irten</button>
          </div>

          <div className="flex p-1 bg-slate-100 rounded-2xl mb-6 shrink-0">
            <button onClick={() => setActiveTab('bilatu')} className={`flex-1 py-3 rounded-xl font-black text-xs uppercase transition-all ${activeTab === 'bilatu' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400'}`}>Bilatu</button>
            <button onClick={() => setActiveTab('historia')} className={`flex-1 py-3 rounded-xl font-black text-xs uppercase transition-all ${activeTab === 'historia' ? 'bg-white text-indigo-600 shadow-sm' : 'text-slate-400'}`}>Historia</button>
          </div>

          {activeTab === 'bilatu' ? (
            <div className="flex flex-col h-full overflow-hidden">
              <div className="relative mb-6 shrink-0">
                <input type="text" placeholder="Bilatu..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-2xl pl-12 pr-4 py-4 font-bold text-indigo-950 placeholder-slate-300 focus:ring-2 focus:ring-indigo-500 transition-all" />
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
              </div>
              <div className="grow overflow-y-auto custom-scrollbar pr-1 space-y-3">
                {isSearching ? <div className="text-center py-10 text-indigo-400 font-black animate-pulse uppercase">BILATZEN...</div> : searchResults.length === 0 ? <div className="text-center py-10 text-slate-300 font-black text-xs uppercase italic">Emaitzarik gabe</div> : searchResults.map((word, idx) => (
                  <div key={`${word.id}-${idx}`} className="bg-slate-50 p-4 rounded-2xl border border-slate-100 flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="text-lg font-black text-indigo-950 uppercase">{word.hitza}</span>
                      <span className={`px-2 py-0.5 rounded-lg border text-[9px] font-black ${levelColors[word.level as keyof typeof levelColors]}`}>L{word.level}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">{word.sinonimoak.map((s, si) => <span key={si} className="bg-white px-3 py-1 rounded-xl border text-[11px] font-bold text-slate-600">{s}</span>)}</div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div className="flex flex-col h-full overflow-hidden">
               <div className="flex justify-center gap-4 mb-4 shrink-0">
                 <button onClick={() => setHistorySubTab('gaur')} className={`text-[10px] font-black uppercase tracking-widest pb-1 border-b-2 transition-all ${historySubTab === 'gaur' ? 'text-indigo-600 border-indigo-600' : 'text-slate-400 border-transparent'}`}>Gaur</button>
                 <button onClick={() => setHistorySubTab('datuak')} className={`text-[10px] font-black uppercase tracking-widest pb-1 border-b-2 transition-all ${historySubTab === 'datuak' ? 'text-indigo-600 border-indigo-600' : 'text-slate-400 border-transparent'}`}>Datuak</button>
                 <button onClick={() => setHistorySubTab('hutsak')} className={`text-[10px] font-black uppercase tracking-widest pb-1 border-b-2 transition-all ${historySubTab === 'hutsak' ? 'text-indigo-600 border-indigo-600' : 'text-slate-400 border-transparent'}`}>Hutsak</button>
               </div>

               <div className="grow overflow-y-auto custom-scrollbar pr-1">
                 {historySubTab === 'gaur' && (
                   <section className="space-y-3 animate-in fade-in duration-300">
                     {historyByDateAndLevel.todayItems.length === 0 ? <p className="text-[10px] font-black text-slate-300 uppercase italic text-center py-8">Ez dago partidarik gaur</p> : historyByDateAndLevel.todayItems.map(item => (
                       <div key={item.id} className="bg-slate-50 border border-slate-100 p-4 rounded-2xl flex flex-col gap-2">
                         <div className="flex justify-between items-center text-[10px] font-black uppercase">
                           <span className="text-slate-400">{new Date(item.played_at).toLocaleTimeString('eu-ES', { hour: '2-digit', minute: '2-digit' })} - L{item.difficulty}</span>
                           <span className="text-indigo-600">{((item.correct / item.total) * 100).toFixed(0)}%</span>
                         </div>
                         <div className="flex justify-between text-xs font-black">
                           <span className="text-emerald-600">✓ {item.correct}</span>
                           <span className="text-rose-500">✕ {item.wrong}</span>
                           <span className="text-slate-400">{item.time_seconds.toFixed(0)}s</span>
                         </div>
                       </div>
                     ))}
                   </section>
                 )}

                 {historySubTab === 'datuak' && (
                   <section className="space-y-4 animate-in fade-in duration-300">
                     <div className="flex justify-between items-center mb-2">
                       <span className="text-[10px] font-black text-slate-400 uppercase">Eguna</span>
                       <input type="date" value={searchDate} onChange={e => setSearchDate(e.target.value)} className="text-[11px] font-black bg-slate-100 rounded-lg p-2 text-indigo-600 outline-none" />
                     </div>
                     {historyByDateAndLevel.searchedStats.length === 0 ? <p className="text-[10px] font-black text-slate-300 uppercase italic text-center py-8">Daturik gabe</p> : historyByDateAndLevel.searchedStats.map(stat => (
                       <div key={stat.level} className={`border rounded-3xl p-5 ${levelColors[stat.level as keyof typeof levelColors]}`}>
                         <div className="flex justify-between items-center mb-3">
                           <span className="text-lg font-black uppercase">L{stat.level} Maila</span>
                           <span className="text-2xl font-black">{stat.percentage.toFixed(0)}%</span>
                         </div>
                         <div className="grid grid-cols-3 gap-2 text-center text-[10px] font-black uppercase">
                           <div className="bg-white/40 p-2 rounded-xl">Guztira: {stat.words}</div>
                           <div className="bg-white/40 p-2 rounded-xl">✓ {stat.correct}</div>
                           <div className="bg-white/40 p-2 rounded-xl">✕ {stat.wrong}</div>
                         </div>
                       </div>
                     ))}
                   </section>
                 )}

                 {historySubTab === 'hutsak' && (
                   <section className="space-y-4 animate-in fade-in duration-300">
                     <div className="flex justify-center gap-2 mb-2 shrink-0">
                       {[1, 2, 3, 4].map(l => (
                         <button 
                           key={l} 
                           onClick={() => setFailedWordsLevel(l as DifficultyLevel)}
                           className={`px-3 py-1.5 rounded-xl text-[10px] font-black uppercase transition-all ${failedWordsLevel === l ? 'bg-indigo-600 text-white shadow-md' : 'bg-slate-100 text-slate-400'}`}
                         >
                           L{l}
                         </button>
                       ))}
                     </div>
                     <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest text-center mb-4">L{failedWordsLevel} Hitz Ahulen Top 10a</h3>
                     {filteredFailedStats.length === 0 ? (
                       <p className="text-[10px] font-black text-slate-300 uppercase italic text-center py-8 px-4">Ez dago hitz ahulik maila honetan oraindik (intentuak &gt; 1 behar dira)</p>
                     ) : (
                       filteredFailedStats.map((stat, i) => (
                        <div key={stat.source_id} className="bg-slate-50 border border-slate-100 p-4 rounded-2xl flex flex-col gap-2 shadow-sm">
                          <div className="flex justify-between items-center">
                            <span className="text-sm font-black text-indigo-950 uppercase">{i + 1}. {stat.hitza}</span>
                            <span className="text-xs font-black text-rose-500">{stat.wrong_rate.toFixed(0)}% Huts</span>
                          </div>
                          <div className="h-1.5 w-full bg-slate-200 rounded-full overflow-hidden">
                            <div className="bg-rose-500 h-full transition-all duration-700" style={{ width: `${stat.wrong_rate}%` }} />
                          </div>
                          <div className="flex justify-between text-[9px] font-black text-slate-400 uppercase">
                            <span>Intentuak: {stat.attempts}</span>
                            <span>Hutsak: {stat.wrong}</span>
                          </div>
                        </div>
                       ))
                     )}
                   </section>
                 )}
               </div>
            </div>
          )}

          <div className="mt-6 shrink-0 pt-4 border-t border-slate-100">
            <div className="flex flex-col gap-4">
              <div className="flex flex-col">
                <label className="text-[10px] font-black text-slate-400 uppercase mb-2 text-center">Maila Aldatu</label>
                <div className="flex gap-2">
                  {[1, 2, 3, 4].map(d => (
                    <button key={d} onClick={() => setDifficulty(d as DifficultyLevel)} className={`flex-1 py-3 rounded-xl font-black text-sm transition-all ${difficulty === d ? 'bg-indigo-600 text-white' : 'bg-slate-50 text-slate-400'}`}>L{d}</button>
                  ))}
                </div>
              </div>
              <button onClick={() => startNewGame(true)} disabled={isLoadingWords} className="w-full bg-indigo-600 text-white font-black py-5 rounded-3xl shadow-lg transition-all active:scale-95 text-xl uppercase tracking-widest flex items-center justify-center gap-3">
                {isLoadingWords ? "KARGATZEN..." : "BAKARKA JOLASTU"}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // --- RENDERING SETUP STATUS ---
  if (status === GameStatus.SETUP) {
    return (
      <div className="h-[100dvh] w-full flex flex-col items-center bg-indigo-950 safe-pt safe-px overflow-hidden">
        <div className="bg-white w-full max-w-xl rounded-[2.5rem] shadow-2xl p-6 md:p-8 flex flex-col h-full max-h-[92dvh] mb-4 overflow-hidden border-2 border-white/20">
          <div className="flex justify-between items-center mb-6 shrink-0">
             <div className="w-10 h-10"></div>
             <div className="text-center">
               <h1 className="text-3xl font-black text-indigo-950 tracking-tighter uppercase leading-none">Sinonimoak</h1>
               <p className="text-[10px] font-bold text-slate-400 mt-1 uppercase tracking-widest">Konfigurazioa</p>
             </div>
             <button onClick={() => setStatus(user ? GameStatus.CONTRIBUTE : GameStatus.AUTH)} className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center text-slate-400 hover:text-indigo-600 shadow-inner">
               <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" /></svg>
             </button>
          </div>

          <div className="space-y-4 mb-4 shrink-0">
             <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
               <label className="flex justify-between text-xs font-black text-indigo-900 uppercase mb-2">Jokalariak: <span className="text-indigo-600 text-xl">{numPlayers}</span></label>
               <input type="range" min="1" max="10" value={numPlayers} onChange={(e) => setNumPlayers(parseInt(e.target.value))} className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer" />
             </div>
             <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100">
               <label className="block text-xs font-black text-indigo-900 uppercase mb-2">Maila</label>
               <div className="grid grid-cols-4 gap-2 h-12">
                 {[1, 2, 3, 4].map(d => <button key={d} onClick={() => setDifficulty(d as DifficultyLevel)} className={`rounded-xl font-black transition-all ${difficulty === d ? 'bg-indigo-600 text-white' : 'bg-white text-slate-400 border border-slate-100'}`}>{d}</button>)}
               </div>
             </div>
          </div>

          <div className="grow overflow-y-auto custom-scrollbar p-2 bg-slate-50/50 rounded-2xl border border-slate-100 shadow-inner mb-4">
             <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
               {players.map(p => (
                 <div key={p.id} className="bg-white p-3 rounded-xl border border-slate-100 flex flex-col shadow-sm">
                   <label className="text-[8px] font-black text-slate-400 uppercase mb-0.5">Jokalaria {p.id + 1}</label>
                   <input type="text" value={p.name} onChange={e => handlePlayerNameChange(p.id, e.target.value)} className="p-0 bg-transparent border-none focus:ring-0 font-bold text-slate-800 text-base" placeholder="Izena..." />
                 </div>
               ))}
             </div>
          </div>

          <button onClick={() => startNewGame()} disabled={isLoadingWords} className="w-full bg-indigo-600 text-white font-black py-5 rounded-3xl shadow-lg active:scale-95 transition-all text-xl uppercase tracking-widest shrink-0">
            {isLoadingWords ? "KARGATZEN..." : "HASI JOKOA"}
          </button>
        </div>
      </div>
    );
  }

  if (status === GameStatus.INTERMISSION) {
    const player = players[currentPlayerIndex];
    return (
      <div className="h-[100dvh] w-full flex flex-col items-center justify-center bg-indigo-950 p-6">
        <div className="bg-white p-10 rounded-[2.5rem] shadow-2xl text-center max-w-sm w-full border-b-[12px] border-indigo-600 animate-in zoom-in duration-300">
          <div className="w-20 h-20 bg-indigo-600 text-white rounded-3xl flex items-center justify-center text-4xl font-black mx-auto mb-6 shadow-xl">{currentPlayerIndex + 1}</div>
          <p className="text-xs text-slate-400 font-black mb-1 uppercase tracking-widest">Prest?</p>
          <h2 className="text-3xl font-black text-slate-900 mb-8 tracking-tight uppercase">{player.name}</h2>
          <button onClick={startPlayerTurn} className="w-full bg-indigo-600 text-white font-black py-5 rounded-2xl shadow-lg active:scale-95 transition-all text-xl uppercase tracking-widest">HASI</button>
        </div>
      </div>
    );
  }

  if (status === GameStatus.PLAYING) {
    const poolIdx = currentPlayerIndex * QUESTIONS_PER_PLAYER + currentQuestionIndex;
    const currentQuestion = questionPool[poolIdx];
    const player = players[currentPlayerIndex];
    if (!currentQuestion) return null;

    return (
      <div className="h-[100dvh] w-full flex flex-col items-center bg-indigo-900 safe-pt safe-px overflow-hidden">
        <div className="w-full max-w-2xl flex justify-between items-center mb-4 px-2 shrink-0">
          <div className="flex items-center gap-2">
            <span className="bg-indigo-600 text-white px-4 py-2 rounded-xl text-xs font-black uppercase">{player.name}</span>
            <span className="text-[10px] font-black text-rose-400">+{currentTurnPenalties}s</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-white font-black text-xs">{currentQuestionIndex + 1}/10</span>
            <button onClick={() => setStatus(GameStatus.SUMMARY)} className="bg-rose-500 text-white font-black px-4 py-2 rounded-xl text-[10px] uppercase">Irten</button>
          </div>
        </div>

        <div className="bg-white w-full max-w-2xl rounded-[2.5rem] shadow-2xl p-6 border border-slate-200 flex flex-col h-full max-h-[85dvh] relative mb-6">
          <div className="absolute top-0 left-0 w-full h-1 bg-slate-100 overflow-hidden">
            <div className="h-full bg-indigo-600 transition-all duration-300" style={{ width: `${((currentQuestionIndex + (isAnswered ? 1 : 0)) / 10) * 100}%` }} />
          </div>
          <div className="text-center my-8 shrink-0">
            <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest mb-1">Sinonimoa aukeratu</p>
            <h3 className="text-4xl md:text-5xl font-black text-slate-900 uppercase tracking-tighter leading-tight">{currentQuestion.wordData.hitza}</h3>
          </div>
          <div className="grid grid-cols-1 gap-3 grow min-h-0 overflow-y-auto">
            {currentQuestion.options.map((opt, i) => {
              let style = "w-full rounded-2xl border-2 font-black text-2xl md:text-3xl transition-all p-4 h-full flex items-center justify-center ";
              if (!isAnswered) style += "bg-white border-slate-100 text-slate-700 hover:border-indigo-500 active:scale-[0.98]";
              else {
                if (opt === currentQuestion.correctAnswer) style += "bg-emerald-500 border-emerald-300 text-white shadow-lg";
                else if (opt === selectedAnswer) style += "bg-rose-500 border-rose-300 text-white";
                else style += "bg-slate-50 border-slate-50 text-slate-300 opacity-40";
              }
              return <button key={i} disabled={isAnswered} onClick={() => handleAnswer(opt)} className={style}>{opt}</button>;
            })}
          </div>
          <div className="mt-8 shrink-0 h-16 flex items-center justify-center">
            {isAnswered && (
              <button onClick={nextQuestion} className="w-full bg-indigo-950 text-white font-black h-full rounded-2xl shadow-lg active:scale-95 text-xl uppercase tracking-widest">
                {currentQuestionIndex < 9 ? "Hurrengoa" : "Bukatu"}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (status === GameStatus.SUMMARY) {
    const isSoloLoggedIn = user && players.length === 1;
    const player = players[0];
    const score = player?.score || 0;
    const percentage = (score / 10) * 100;

    return (
      <div className="h-[100dvh] w-full flex flex-col items-center bg-indigo-950 safe-pt safe-px overflow-hidden">
        <div className="bg-white w-full max-w-2xl rounded-[2.5rem] shadow-2xl p-6 md:p-8 flex flex-col h-full max-h-[92dvh] border-t-[12px] border-indigo-600 mt-2 mb-6 overflow-hidden">
          <h2 className="text-3xl font-black text-slate-900 uppercase text-center mb-6">{isSoloLoggedIn ? "Zure Emaitzak" : "Sailkapena"}</h2>
          
          <div className="grow overflow-hidden rounded-[2rem] border border-slate-200 bg-slate-50/50 mb-6 flex flex-col">
            {isSoloLoggedIn ? (
              <div className="h-full flex flex-col items-center justify-center p-4 space-y-6">
                <div className="relative w-32 h-32 flex items-center justify-center">
                   <svg className="w-full h-full -rotate-90">
                     <circle cx="64" cy="64" r="56" stroke="currentColor" strokeWidth="10" fill="transparent" className="text-slate-200" />
                     <circle cx="64" cy="64" r="56" stroke="currentColor" strokeWidth="10" fill="transparent" strokeDasharray={351.8} strokeDashoffset={351.8 - (351.8 * percentage) / 100} strokeLinecap="round" className="text-indigo-600 transition-all duration-1000" />
                   </svg>
                   <div className="absolute text-center">
                     <span className="text-3xl font-black text-indigo-950">{percentage.toFixed(0)}%</span>
                   </div>
                </div>
                <div className="grid grid-cols-2 gap-3 w-full max-w-sm text-center">
                  <div className="bg-white p-4 rounded-3xl border border-emerald-100"><p className="text-[9px] font-black uppercase mb-0.5 text-emerald-400">Asmatuak</p><p className="text-2xl font-black text-emerald-600">{score}</p></div>
                  <div className="bg-white p-4 rounded-3xl border border-rose-100"><p className="text-[9px] font-black uppercase mb-0.5 text-rose-400">Hutsak</p><p className="text-2xl font-black text-rose-600">{10 - score}</p></div>
                  <div className="bg-white p-4 rounded-3xl border border-indigo-100 col-span-2"><p className="text-[9px] font-black uppercase mb-0.5 text-indigo-400">Denbora</p><p className="text-2xl font-black text-indigo-950">{player.time.toFixed(1)}s</p></div>
                </div>
              </div>
            ) : (
              <div className="overflow-y-auto custom-scrollbar grow p-2">
                <table className="w-full text-left border-collapse">
                  <thead className="sticky top-0 bg-slate-100"><tr><th className="p-3 text-[9px] font-black uppercase">#</th><th className="p-3 text-[9px] font-black uppercase">Nor</th><th className="p-3 text-center text-[9px] font-black uppercase">Pts</th><th className="p-3 text-right text-[9px] font-black uppercase">S.</th></tr></thead>
                  <tbody>{[...players].filter(p => p.time > 0).sort((a,b) => b.score === a.score ? a.time - b.time : b.score - a.score).map((p, idx) => (
                    <tr key={p.id} className="border-b border-slate-100 bg-white"><td className="p-3 font-black text-xl">{idx+1}</td><td className="p-3 font-black text-xs uppercase">{p.name}</td><td className="p-3 text-center"><span className="bg-indigo-600 text-white px-2 py-0.5 rounded text-[10px] font-black">{p.score}</span></td><td className="p-3 text-right font-mono text-[10px] text-slate-400">{p.time.toFixed(1)}s</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2 shrink-0">
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => { setPlayers(players.map(p => ({...p, score:0, time:0}))); startNewGame(players.length === 1); }} className="bg-indigo-600 text-white font-black py-4 rounded-2xl shadow-lg uppercase text-xs">Berriro</button>
              <button onClick={() => setStatus(GameStatus.REVIEW)} className="bg-white text-indigo-600 font-black py-4 rounded-2xl shadow-md uppercase text-xs border border-indigo-100">Hitzak</button>
            </div>
            <button onClick={() => setStatus(user ? GameStatus.CONTRIBUTE : GameStatus.SETUP)} className="w-full bg-slate-100 text-slate-500 font-black py-3 rounded-xl uppercase text-[10px]">Hasiera</button>
          </div>
        </div>
      </div>
    );
  }

  if (status === GameStatus.REVIEW) {
    return (
      <div className="h-[100dvh] w-full flex flex-col items-center bg-slate-900 safe-pt safe-px overflow-hidden">
        <div className="bg-white w-full max-w-2xl rounded-[2.5rem] shadow-2xl p-6 flex flex-col h-full max-h-[92dvh] border-t-[12px] border-indigo-600 mt-2 mb-6">
          <div className="flex justify-between items-center mb-6 shrink-0">
            <button onClick={() => setStatus(GameStatus.SUMMARY)} className="bg-slate-100 text-slate-600 px-4 py-2 rounded-xl text-[10px] font-black uppercase">Atzera</button>
            <h2 className="text-lg font-black text-indigo-950 uppercase">Hiztegia</h2>
            <div className="w-16"></div>
          </div>
          <div className="grow overflow-y-auto custom-scrollbar space-y-3 p-1">
            {playedWordData.map((data, idx) => (
              <div key={idx} className="bg-slate-50 p-4 rounded-2xl border border-slate-100 flex flex-col gap-2 shadow-sm">
                <div className="flex items-center gap-2"><span className="bg-indigo-600 text-white px-2 py-0.5 rounded text-[8px] font-black">#{idx+1}</span><span className="font-black text-indigo-950 uppercase">{data.hitza}</span></div>
                <div className="flex flex-wrap gap-1.5">{data.sinonimoak.map((s, si) => <span key={si} className="bg-white px-3 py-1 rounded-xl border text-[11px] font-bold text-indigo-600">{s}</span>)}</div>
              </div>
            ))}
          </div>
          <button onClick={() => setStatus(GameStatus.SUMMARY)} className="w-full bg-indigo-600 text-white font-black py-5 rounded-2xl shadow-lg uppercase mt-4">Itxi</button>
        </div>
      </div>
    );
  }

  return null;
};

export default App;
