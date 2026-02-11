
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
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<(WordData & { level: number })[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [history, setHistory] = useState<any[]>([]);
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

  // Search Logic - Fixed to ensure results show up when searching words OR synonyms
  useEffect(() => {
    const performSearch = async () => {
      if (!searchTerm || searchTerm.length < 2) {
        setSearchResults([]);
        return;
      }
      setIsSearching(true);
      
      // We use a more direct approach to query both hitza and the text representation of sinonimoak
         const { data, error } = await supabase
          .from("syn_words")
          .select("source_id, hitza, sinonimoak, level, part")
          .ilike("search_text", `%${searchTerm.toLowerCase()}%`)
          .eq("active", true)
          .limit(100);

      if (!error && data) {
        setSearchResults(data.map((r: any) => ({
          id: r.source_id,
          hitza: r.hitza,
          sinonimoak: Array.isArray(r.sinonimoak) ? r.sinonimoak : [],
          level: r.level
        })));
      } else if (error) {
        console.error("Search error:", error);
      }
      setIsSearching(false);
    };

    const timer = setTimeout(performSearch, 400);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  const fetchWordsFromSupabase = async (level: DifficultyLevel): Promise<WordData[]> => {
    const { data, error } = await supabase
      .from("syn_words")
      .select("source_id, hitza, sinonimoak")
      .eq("level", level)
      .eq("active", true);

    if (error) {
      console.error(error);
      return [];
    }

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
    
    if (!error && data) {
      setHistory(data);
    }
  };

  const generatePoolFromData = (needed: number, poolSource: WordData[]) => {
    let gameData = [...poolSource];
    while (gameData.length < needed) {
      gameData = [...gameData, ...poolSource];
    }
    gameData = shuffleArray(gameData).slice(0, needed);
    const allWordsInPool = poolSource.flatMap((d) => [d.hitza, ...d.sinonimoak]);

    return gameData.map((data) => {
      const correctAnswer = data.sinonimoak[Math.floor(Math.random() * data.sinonimoak.length)];
      const targetType = getWordType(data.hitza);
      const distractorsPool = allWordsInPool.filter((w) => w !== data.hitza && !data.sinonimoak.includes(w));
      const sameTypeDistractors = distractorsPool.filter((w) => getWordType(w) === targetType);
      const finalDistractorsSource = sameTypeDistractors.length >= 10 ? sameTypeDistractors : distractorsPool;
      const shuffledDistractors = shuffleArray(Array.from(new Set(finalDistractorsSource))).slice(0, 3);
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
    const newPool = generatePoolFromData(totalNeeded, poolSource);
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

  const handleAnswer = (answer: string) => {
    if (isAnswered) return;
    const poolIdx = (currentPlayerIndex * QUESTIONS_PER_PLAYER + currentQuestionIndex);
    const currentQuestion = poolIdx >= 0 && poolIdx < questionPool.length ? questionPool[poolIdx] : null;
    if (!currentQuestion) return;
    const isCorrect = answer === currentQuestion.correctAnswer;
    setSelectedAnswer(answer);
    setIsAnswered(true);
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
    const { error } = await supabase.from('game_runs').insert({
      user_id: user.id,
      played_at: new Date().toISOString(),
      difficulty: difficulty,
      total: QUESTIONS_PER_PLAYER,
      correct: player.score,
      wrong: QUESTIONS_PER_PLAYER - player.score,
      time_seconds: player.time,
    });
    setIsSaving(false);
    if (!error) fetchHistory();
  };

  const finishPlayerTurn = async () => {
    const endTime = Date.now();
    const realSeconds = (endTime - turnStartTimeRef.current) / 1000;
    const totalSecondsWithPenalty = realSeconds + currentTurnPenalties;
    
    const updatedPlayers = players.map((p, idx) => 
      idx === currentPlayerIndex ? { ...p, time: totalSecondsWithPenalty } : p
    );
    setPlayers(updatedPlayers);

    if (currentPlayerIndex < players.length - 1) {
      setCurrentPlayerIndex(prev => prev + 1);
      setStatus(GameStatus.INTERMISSION);
    } else {
      if (user && players.length === 1) {
        await saveToSupabase(updatedPlayers[0]);
      }
      setStatus(GameStatus.SUMMARY);
    }
  };

  const playedWordData = useMemo(() => {
    return Array.from(new Map<string, WordData>(questionPool.map(q => [q.wordData.hitza, q.wordData])).values())
      .sort((a, b) => a.hitza.localeCompare(b.hitza));
  }, [questionPool]);

  // History computed stats
  const historyByDateAndLevel = useMemo(() => {
    const todayStr = new Date().toISOString().split('T')[0];
    
    const statsForDate = (dateStr: string) => {
      const items = history.filter(h => h.played_at.startsWith(dateStr));
      const levels = [1, 2, 3, 4];
      return levels.map(lvl => {
        const lvlItems = items.filter(h => h.difficulty === lvl);
        const totalWords = lvlItems.reduce((acc, h) => acc + h.total, 0);
        const totalCorrect = lvlItems.reduce((acc, h) => acc + h.correct, 0);
        const totalWrong = lvlItems.reduce((acc, h) => acc + h.wrong, 0);
        return {
          level: lvl,
          words: totalWords,
          correct: totalCorrect,
          wrong: totalWrong,
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

  if (status === GameStatus.AUTH) {
    return (
      <div className="h-[100dvh] w-full flex flex-col items-center justify-center bg-indigo-950 p-6">
        <div className="bg-white w-full max-w-md rounded-[2.5rem] shadow-2xl p-8 border-b-8 border-indigo-600">
          <button onClick={() => setStatus(GameStatus.SETUP)} className="mb-4 text-xs font-black text-slate-400 uppercase tracking-widest">← Atzera</button>
          <h2 className="text-3xl font-black text-indigo-950 mb-1 uppercase tracking-tighter">Logina</h2>
          <p className="text-[10px] font-bold text-slate-400 mb-6 uppercase tracking-widest">Sartu zure erabiltzaile IDa</p>
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-[10px] font-black text-slate-400 uppercase mb-1">Erabiltzaile ID</label>
              <input type="text" placeholder="Adib: alumno-0001" value={username} onChange={e => setUsername(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-4 font-bold text-slate-800" required />
            </div>
            <div>
              <label className="block text-[10px] font-black text-slate-400 uppercase mb-1">Pasahitza</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-2xl p-4 font-bold text-slate-800" required />
            </div>
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
                <input 
                  type="text" 
                  placeholder="Hitz bat edo sinonimo bat bilatu..." 
                  value={searchTerm} 
                  onChange={e => setSearchTerm(e.target.value)} 
                  className="w-full bg-slate-50 border border-slate-200 rounded-2xl pl-12 pr-4 py-4 font-bold text-indigo-950 placeholder-slate-300 focus:ring-2 focus:ring-indigo-500 focus:border-transparent transition-all"
                />
                <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5 absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
              </div>

              <div className="grow overflow-y-auto custom-scrollbar pr-1 space-y-3">
                {isSearching ? (
                  <div className="text-center py-10 text-indigo-400 font-black animate-pulse">BILATZEN...</div>
                ) : searchTerm.length < 2 ? (
                  <div className="h-full flex flex-col items-center justify-center text-slate-300 gap-4 opacity-50">
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-16 w-16" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253m0-13C13.168 5.477 14.754 5 16.5 5c1.747 0 3.332.477 4.5 1.253v13C19.832 18.477 18.247 18 16.5 18c-1.746 0-3.332.477-4.5 1.253" />
                    </svg>
                    <p className="font-black text-xs uppercase tracking-widest text-center">Idatzi gutxienez bi hizki<br/>hitzak edo sinonimoak bilatzeko</p>
                  </div>
                ) : searchResults.length === 0 ? (
                  <div className="text-center py-10">
                    <p className="text-sm font-bold text-slate-400">Ez da emaitzarik aurkitu</p>
                  </div>
                ) : (
                  searchResults.map((word, idx) => (
                    <div key={`${word.id}-${idx}`} className="bg-slate-50 p-4 rounded-2xl border border-slate-100 flex flex-col gap-2 hover:border-indigo-200 transition-colors">
                      <div className="flex items-center justify-between">
                        <a 
                          href={`https://hiztegiak.elhuyar.eus/eu/${word.hitza}`} 
                          target="_blank" 
                          rel="noopener noreferrer" 
                          className="text-lg font-black text-indigo-950 uppercase hover:text-indigo-600 transition-colors flex items-center gap-2 group"
                        >
                          {word.hitza}
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-slate-300 group-hover:text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                          </svg>
                        </a>
                        <span className={`px-2 py-0.5 rounded-lg border text-[9px] font-black ${levelColors[word.level as keyof typeof levelColors]}`}>L{word.level}</span>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {word.sinonimoak.map((s, si) => (
                          <span key={si} className={`bg-white px-3 py-1 rounded-xl border text-[11px] font-bold ${s.toLowerCase().includes(searchTerm.toLowerCase()) ? 'text-indigo-600 border-indigo-200 bg-indigo-50' : 'text-slate-600 border-slate-100'}`}>{s}</span>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col h-full overflow-hidden">
               <div className="grow overflow-y-auto custom-scrollbar pr-1 space-y-6">
                 
                 {/* GAURKO PARTIDAK */}
                 <section>
                   <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3 flex items-center gap-2">
                     <span className="w-2 h-2 bg-emerald-500 rounded-full"></span>
                     Gaurko Partidak
                   </h3>
                   <div className="space-y-3">
                     {historyByDateAndLevel.todayItems.length === 0 ? (
                       <p className="text-[10px] font-bold text-slate-300 uppercase italic">Ez duzu partidarik jokatu gaur</p>
                     ) : (
                       historyByDateAndLevel.todayItems.map(item => {
                         const perc = ((item.correct / item.total) * 100).toFixed(0);
                         return (
                           <div key={item.id} className="bg-slate-50 border border-slate-100 p-4 rounded-2xl flex flex-col gap-2">
                             <div className="flex justify-between items-center">
                               <div className="flex flex-col">
                                 <span className="text-[8px] font-black text-slate-400 uppercase">{new Date(item.played_at).toLocaleTimeString('eu-ES', { hour: '2-digit', minute: '2-digit' })}</span>
                                 <span className="text-xs font-black text-indigo-900 uppercase">L{item.difficulty} Maila</span>
                               </div>
                               <div className="flex items-center gap-3">
                                 <div className="flex flex-col items-end">
                                   <div className="flex gap-2 text-xs font-black">
                                     <span className="text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-md">Asmatuak: {item.correct}</span>
                                     <span className="text-rose-500 bg-rose-50 px-1.5 py-0.5 rounded-md">Hutsak: {item.wrong}</span>
                                   </div>
                                   <span className="text-[9px] font-black text-indigo-600 uppercase mt-1">Emaitza: {perc}%</span>
                                 </div>
                                 <div className="h-8 w-px bg-slate-200"></div>
                                 <span className="text-xs font-black text-slate-500">{item.time_seconds.toFixed(0)}s</span>
                               </div>
                             </div>
                             <div className="h-1.5 w-full bg-slate-200 rounded-full overflow-hidden flex">
                               <div className="bg-emerald-500 h-full transition-all duration-1000" style={{ width: `${perc}%` }} />
                               <div className="bg-rose-500 h-full transition-all duration-1000" style={{ width: `${100 - parseInt(perc)}%` }} />
                             </div>
                           </div>
                         );
                       })
                     )}
                   </div>
                 </section>

                 <hr className="border-slate-100" />

                 {/* DATA BILATZAILEA */}
                 <section>
                   <div className="flex justify-between items-center mb-4">
                     <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Datu Metatuak (Mailaka)</h3>
                     <input 
                       type="date" 
                       value={searchDate} 
                       onChange={e => setSearchDate(e.target.value)}
                       className="text-[11px] font-black bg-slate-100 border-none rounded-lg p-2 text-indigo-600 outline-none"
                     />
                   </div>

                   <div className="space-y-4">
                     {historyByDateAndLevel.searchedStats.length === 0 ? (
                       <div className="bg-slate-50 border-2 border-dashed border-slate-200 p-8 rounded-3xl text-center">
                         <p className="text-[10px] font-black text-slate-300 uppercase">Ez dago daturik egun honetan</p>
                       </div>
                     ) : (
                       historyByDateAndLevel.searchedStats.map(stat => {
                         const colorClass = levelColors[stat.level as keyof typeof levelColors] || '';
                         return (
                           <div key={stat.level} className={`border rounded-3xl p-5 shadow-sm transition-all hover:shadow-md ${colorClass}`}>
                             <div className="flex justify-between items-center mb-4">
                               <div className="flex flex-col">
                                 <span className="text-xl font-black uppercase tracking-tighter">L{stat.level} Maila</span>
                                 <span className="text-[9px] font-black opacity-60 uppercase">{stat.sessions} Saio jokatuta</span>
                               </div>
                               <div className="bg-white/80 px-4 py-2 rounded-2xl border border-black/5 text-center shadow-sm">
                                 <p className="text-[8px] font-black opacity-40 uppercase">Asmatze %</p>
                                 <p className="text-xl font-black text-indigo-950">{stat.percentage.toFixed(0)}%</p>
                               </div>
                             </div>
                             
                             <div className="grid grid-cols-3 gap-2">
                               <div className="bg-white/40 p-3 rounded-2xl text-center flex flex-col">
                                 <span className="text-[8px] font-black opacity-50 uppercase mb-1 text-slate-600">Guztira</span>
                                 <span className="text-sm font-black text-slate-800">{stat.words}</span>
                               </div>
                               <div className="bg-white/40 p-3 rounded-2xl text-center flex flex-col">
                                 <span className="text-[8px] font-black opacity-50 uppercase mb-1 text-emerald-700">Asmatuak</span>
                                 <span className="text-sm font-black text-emerald-600">{stat.correct}</span>
                               </div>
                               <div className="bg-white/40 p-3 rounded-2xl text-center flex flex-col">
                                 <span className="text-[8px] font-black opacity-50 uppercase mb-1 text-rose-700">Hutsak</span>
                                 <span className="text-sm font-black text-rose-500">{stat.wrong}</span>
                               </div>
                             </div>

                             <div className="mt-4 h-2 w-full bg-black/5 rounded-full overflow-hidden flex">
                               <div className="bg-emerald-500 h-full transition-all duration-1000" style={{ width: `${stat.percentage}%` }} />
                               <div className="bg-rose-500 h-full transition-all duration-1000" style={{ width: `${100 - stat.percentage}%` }} />
                             </div>
                           </div>
                         );
                       })
                     )}
                   </div>
                 </section>

               </div>
            </div>
          )}

          <div className="mt-6 shrink-0 pt-4 border-t border-slate-100">
            <div className="flex flex-col gap-4">
              <div className="flex flex-col">
                <label className="text-[10px] font-black text-slate-400 uppercase mb-2 text-center">Bakarka Jolasteko Maila</label>
                <div className="flex gap-2">
                  {([1, 2, 3, 4] as DifficultyLevel[]).map(d => (
                    <button 
                      key={d} 
                      onClick={() => setDifficulty(d)} 
                      className={`flex-1 py-3 rounded-xl font-black text-sm transition-all ${difficulty === d ? 'bg-indigo-600 text-white shadow-md scale-105' : 'bg-slate-50 text-slate-400 border border-slate-100'}`}
                    >
                      L{d}
                    </button>
                  ))}
                </div>
              </div>
              <button 
                onClick={() => startNewGame(true)} 
                disabled={isLoadingWords}
                className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white font-black py-5 rounded-3xl shadow-lg transition-all active:scale-95 text-xl uppercase tracking-widest flex items-center justify-center gap-3"
              >
                {isLoadingWords ? "KARGATZEN..." : (
                  <>
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 001.555-.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
                    </svg>
                    BAKARKA JOLASTU
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (status === GameStatus.SETUP) {
    return (
      <div className="h-[100dvh] w-full flex flex-col items-center bg-gradient-to-br from-indigo-900 via-indigo-950 to-black overflow-hidden safe-pt safe-px">
        <div className="bg-white rounded-[2.5rem] shadow-2xl w-full max-w-xl flex flex-col h-full max-h-[92dvh] border-2 border-white/20 p-6 mt-2 mb-4">
          <div className="flex justify-between items-start mb-6 shrink-0">
            <div className="w-10"></div>
            <div className="text-center grow">
              <h1 className="text-3xl font-black text-indigo-950 tracking-tighter uppercase leading-none">Sinonimoak</h1>
              <p className="text-[10px] font-bold text-slate-400 mt-1 uppercase tracking-widest">Konfigurazioa</p>
            </div>
            <button onClick={() => setStatus(user ? GameStatus.CONTRIBUTE : GameStatus.AUTH)} className="w-10 h-10 bg-slate-100 rounded-full flex items-center justify-center text-slate-400 hover:text-indigo-600 transition-colors shadow-inner">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
          
          <div className="flex flex-col gap-4 mb-4 shrink-0">
            <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 shadow-sm">
               <label className="flex justify-between text-xs font-black text-indigo-900 uppercase mb-2">
                 Jokalariak: <span className="text-indigo-600 text-xl">{numPlayers}</span>
               </label>
               <input type="range" min="1" max="10" value={numPlayers} onChange={(e) => setNumPlayers(parseInt(e.target.value))} className="w-full h-2 bg-slate-200 rounded-lg appearance-none cursor-pointer" />
            </div>
            
            <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 shadow-sm">
               <label className="block text-xs font-black text-indigo-900 uppercase mb-2">Zailtasuna</label>
               <div className="grid grid-cols-4 gap-2 h-12">
                 {([1, 2, 3, 4] as DifficultyLevel[]).map(d => (
                   <button key={d} onClick={() => setDifficulty(d)} className={`rounded-xl transition-all text-base font-black ${difficulty === d ? 'bg-indigo-600 text-white shadow-md' : 'bg-white text-slate-400 border border-slate-100'}`}>
                     {d}
                   </button>
                 ))}
               </div>
            </div>
          </div>

          <div className="grow overflow-y-auto pr-1 custom-scrollbar mb-4 min-h-0 bg-slate-50/50 rounded-2xl p-2 border border-slate-100 shadow-inner">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {players.map((p) => (
                <div key={p.id} className="bg-white p-3 rounded-xl border border-slate-100 flex flex-col focus-within:ring-2 focus-within:ring-indigo-500 transition-all shadow-sm">
                  <label className="text-[8px] font-black text-slate-400 uppercase mb-0.5">Jokalaria {p.id + 1}</label>
                  <input type="text" value={p.name} onChange={(e) => handlePlayerNameChange(p.id, e.target.value)} className="p-0 bg-transparent border-none focus:ring-0 font-bold text-slate-800 text-base" placeholder="Izena..." />
                </div>
              ))}
            </div>
          </div>

          <div className="shrink-0 pb-2">
            <button onClick={() => startNewGame()} disabled={isLoadingWords} className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white font-black py-5 rounded-3xl transition-all shadow-lg active:scale-95 text-xl uppercase tracking-widest">
              {isLoadingWords ? "KARGATZEN..." : "HASI JOKOA"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (status === GameStatus.INTERMISSION) {
    const player = players[currentPlayerIndex];
    return (
      <div className="h-[100dvh] w-full flex flex-col items-center justify-center bg-indigo-950 overflow-hidden safe-pt safe-px">
        <div className="bg-white p-10 rounded-[2.5rem] shadow-2xl text-center max-w-sm w-full border-b-[12px] border-indigo-600 mx-4 animate-in zoom-in duration-300">
          <div className="w-20 h-20 bg-indigo-600 text-white rounded-3xl flex items-center justify-center text-4xl font-black mx-auto mb-6 shadow-xl">{currentPlayerIndex + 1}</div>
          <p className="text-xs text-slate-400 font-black mb-1 uppercase tracking-widest">Prest?</p>
          <h2 className="text-3xl font-black text-slate-900 mb-8 tracking-tight">{player.name}</h2>
          <button onClick={startPlayerTurn} className="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-black py-5 rounded-2xl transition-all shadow-lg active:scale-95 text-xl uppercase tracking-widest">HASI</button>
        </div>
      </div>
    );
  }

  if (status === GameStatus.PLAYING) {
    const poolIdx = (currentPlayerIndex * QUESTIONS_PER_PLAYER + currentQuestionIndex);
    const currentQuestion = poolIdx >= 0 && poolIdx < questionPool.length ? questionPool[poolIdx] : null;
    const currentPlayer = players[currentPlayerIndex];
    if (!currentQuestion) return null;

    return (
      <div className="h-[100dvh] w-full flex flex-col items-center bg-indigo-900 overflow-hidden safe-pt safe-px">
        <div className="w-full max-w-2xl flex justify-between items-center mb-4 gap-2 shrink-0 px-2">
          <div className="flex items-center space-x-2">
             <div className="bg-indigo-600 text-white px-5 py-2.5 rounded-2xl text-[12px] font-black shadow-lg uppercase tracking-tight">{currentPlayer.name}</div>
             <div className="bg-white/10 backdrop-blur-md px-3 py-2 rounded-xl border border-white/20 flex items-center gap-2">
               <span className="text-[10px] font-black text-rose-400 uppercase leading-none">+{currentTurnPenalties}s</span>
             </div>
          </div>
          <div className="flex gap-2 items-center">
            <div className="bg-white/10 backdrop-blur-md px-4 py-2 rounded-xl border border-white/20 text-white font-black text-xs">
              {currentQuestionIndex + 1}/10
            </div>
            <button onClick={() => setStatus(GameStatus.SUMMARY)} className="bg-rose-500 text-white font-black px-5 py-2.5 rounded-2xl text-[11px] uppercase shadow-lg active:scale-95 transition-transform">Amaitu</button>
          </div>
        </div>

        <div className="bg-white w-full max-w-2xl rounded-[2.5rem] shadow-2xl p-6 border border-slate-200 relative overflow-hidden flex flex-col h-full max-h-[85dvh] mb-6">
          <div className="absolute top-0 left-0 w-full h-1.5 bg-slate-100">
            <div className="h-full bg-indigo-600 transition-all duration-300" style={{ width: `${((currentQuestionIndex + (isAnswered ? 1 : 0)) / QUESTIONS_PER_PLAYER) * 100}%` }} />
          </div>
          
          <div className="text-center my-6 md:my-10 shrink-0">
            <p className="text-[10px] font-black text-indigo-400 uppercase tracking-[0.4em] mb-2">Sinonimoa aukeratu</p>
            <h3 className="text-4xl md:text-6xl font-black text-slate-900 break-words leading-tight uppercase tracking-tighter">{currentQuestion.wordData.hitza}</h3>
          </div>

          <div className="grid grid-cols-1 gap-3 grow min-h-0">
            {currentQuestion.options.map((opt, i) => {
              let buttonStyle = "w-full rounded-2xl border-2 font-black text-2xl md:text-4xl transition-all duration-200 flex items-center justify-center text-center p-4 h-full ";
              if (!isAnswered) buttonStyle += "bg-white border-slate-100 hover:border-indigo-500 hover:bg-indigo-50 text-slate-700 shadow-md active:translate-y-1";
              else {
                if (opt === currentQuestion.correctAnswer) buttonStyle += "bg-emerald-500 border-emerald-300 text-white shadow-xl scale-[1.02]";
                else if (opt === selectedAnswer) buttonStyle += "bg-rose-500 border-rose-300 text-white opacity-90";
                else buttonStyle += "bg-slate-50 border-slate-50 text-slate-300 opacity-40";
              }
              return (
                <button key={i} disabled={isAnswered} onClick={() => handleAnswer(opt)} className={buttonStyle}>{opt}</button>
              );
            })}
          </div>

          <div className="mt-8 shrink-0">
            <div className="h-20 flex items-center justify-center">
              {isAnswered ? (
                 <button onClick={nextQuestion} className="w-full bg-indigo-950 text-white font-black h-full rounded-2xl shadow-xl active:scale-95 text-2xl uppercase tracking-widest">
                   {currentQuestionIndex < 9 ? "Hurrengoa" : "Bukatu"}
                 </button>
              ) : (
                 <div className="flex items-center gap-3 text-[11px] font-black text-slate-300 uppercase tracking-widest animate-pulse">
                   <span className="w-2.5 h-2.5 bg-indigo-300 rounded-full"></span>
                   Erantzunaren zain...
                 </div>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (status === GameStatus.SUMMARY) {
    // Determine if we show personal summary (logged in / solo) or ranking (multiplayer / guest)
    const isSoloLoggedIn = user && players.length === 1;
    const player = players[0];
    const score = player.score;
    const total = QUESTIONS_PER_PLAYER;
    const wrong = total - score;
    const percentage = (score / total) * 100;

    const sortedPlayers = [...players].filter(p => p.time > 0).sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.time - b.time;
      });

    return (
      <div className="h-[100dvh] w-full flex flex-col items-center bg-indigo-950 overflow-hidden safe-pt safe-px">
        <div className="bg-white w-full max-w-2xl rounded-[2.5rem] shadow-2xl p-6 md:p-10 flex flex-col h-full max-h-[92dvh] border-t-[12px] border-indigo-600 mt-2 mb-6">
          <div className="mb-8 shrink-0 text-center pt-2">
            <h2 className="text-4xl font-black text-slate-900 uppercase tracking-tighter">
              {isSoloLoggedIn ? "Zure Emaitzak" : "Sailkapena"}
            </h2>
            <p className="text-xs font-black text-indigo-400 uppercase tracking-[0.3em] mt-2">{difficulty}. Maila</p>
          </div>
          
          <div className="grow overflow-hidden rounded-[2rem] border border-slate-200 shadow-inner bg-slate-50/50 mb-8 flex flex-col">
            {isSoloLoggedIn ? (
              /* PERSONAL SUMMARY DASHBOARD */
              <div className="grow flex flex-col items-center justify-center p-6 space-y-6 overflow-y-auto custom-scrollbar">
                <div className="relative w-40 h-40 flex items-center justify-center">
                   <svg className="w-full h-full -rotate-90">
                     <circle cx="80" cy="80" r="70" stroke="currentColor" strokeWidth="12" fill="transparent" className="text-slate-200" />
                     <circle cx="80" cy="80" r="70" stroke="currentColor" strokeWidth="12" fill="transparent" strokeDasharray={440} strokeDashoffset={440 - (440 * percentage) / 100} strokeLinecap="round" className="text-indigo-600 transition-all duration-1000" />
                   </svg>
                   <div className="absolute flex flex-col items-center">
                     <span className="text-4xl font-black text-indigo-950">{percentage}%</span>
                     <span className="text-[10px] font-black text-slate-400 uppercase">Zuzentasuna</span>
                   </div>
                </div>

                <div className="grid grid-cols-2 gap-4 w-full max-w-sm">
                  <div className="bg-white p-5 rounded-3xl border border-emerald-100 shadow-sm text-center">
                    <p className="text-[10px] font-black text-emerald-400 uppercase mb-1">Asmatuak</p>
                    <p className="text-3xl font-black text-emerald-600">{score}</p>
                  </div>
                  <div className="bg-white p-5 rounded-3xl border border-rose-100 shadow-sm text-center">
                    <p className="text-[10px] font-black text-rose-400 uppercase mb-1">Hutsak</p>
                    <p className="text-3xl font-black text-rose-600">{wrong}</p>
                  </div>
                  <div className="bg-white p-5 rounded-3xl border border-indigo-100 shadow-sm text-center col-span-2">
                    <p className="text-[10px] font-black text-indigo-400 uppercase mb-1">Denbora Totala</p>
                    <p className="text-3xl font-black text-indigo-950">{player.time.toFixed(1)}s</p>
                    <p className="text-[8px] font-bold text-slate-300 uppercase mt-1">Huts bakoitzeko +10s-ko zigorra barne</p>
                  </div>
                </div>
              </div>
            ) : (
              /* MULTIPLAYER RANKING TABLE */
              <div className="overflow-y-auto custom-scrollbar grow p-2">
                <table className="w-full text-left border-collapse">
                  <thead className="sticky top-0 bg-slate-100 z-10">
                    <tr>
                      <th className="px-5 py-4 text-[10px] font-black text-slate-500 uppercase tracking-widest">#</th>
                      <th className="px-5 py-4 text-[10px] font-black text-slate-500 uppercase tracking-widest">Nor</th>
                      <th className="px-5 py-4 text-[10px] font-black text-slate-500 uppercase tracking-widest text-center">Pts</th>
                      <th className="px-5 py-4 text-[10px] font-black text-slate-500 uppercase tracking-widest text-right">S.</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 bg-white">
                    {sortedPlayers.map((p, idx) => (
                      <tr key={p.id} className={idx === 0 ? "bg-amber-50" : ""}>
                        <td className="px-5 py-5 font-black text-2xl">{idx === 0 ? "🥇" : idx === 1 ? "🥈" : idx === 2 ? "🥉" : `${idx + 1}.`}</td>
                        <td className="px-5 py-5 font-black text-slate-800 text-sm uppercase">{p.name}</td>
                        <td className="px-5 py-5 text-center">
                          <span className="bg-indigo-600 text-white px-3 py-1 rounded-xl font-black text-xs shadow-sm">{p.score}</span>
                        </td>
                        <td className="px-5 py-5 text-right font-mono text-slate-500 text-xs">{p.time.toFixed(1)}s</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3 shrink-0 pb-2 mb-4">
            {isSaving && <p className="text-center text-[10px] font-black text-indigo-600 animate-pulse uppercase">Emaitza gordetzen...</p>}
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => { setPlayers(players.map(p => ({...p, score: 0, time: 0}))); startNewGame(players.length === 1); }} className="bg-indigo-600 text-white font-black py-5 rounded-2xl shadow-lg text-sm uppercase tracking-widest active:scale-95">BERRIRO</button>
              <button onClick={() => setStatus(GameStatus.REVIEW)} className="bg-white text-indigo-600 font-black py-5 rounded-2xl shadow-md text-sm uppercase tracking-widest border border-indigo-100 active:scale-95">HITZAK</button>
            </div>
            <button onClick={() => setStatus(user ? GameStatus.CONTRIBUTE : GameStatus.SETUP)} className="w-full bg-slate-100 text-slate-500 font-black py-4 rounded-xl text-[11px] uppercase active:scale-95">HASIERA</button>
          </div>
        </div>
      </div>
    );
  }

  if (status === GameStatus.REVIEW) {
    return (
      <div className="h-[100dvh] w-full flex flex-col items-center bg-slate-900 overflow-hidden safe-pt safe-px">
        <div className="bg-white w-full max-w-2xl rounded-[2.5rem] shadow-2xl p-6 md:p-10 flex flex-col h-full max-h-[92dvh] border-t-[12px] border-indigo-600 mt-2 mb-6">
          <div className="flex justify-between items-center mb-6 shrink-0 pt-2">
            <button onClick={() => setStatus(GameStatus.SUMMARY)} className="bg-slate-100 text-slate-600 px-5 py-2.5 rounded-2xl font-black text-[11px] uppercase active:scale-95 transition-transform shadow-sm">
              Atzera
            </button>
            <h2 className="text-lg font-black text-indigo-950 uppercase tracking-tight">Hiztegia</h2>
            <div className="w-16"></div>
          </div>

          <div className="grow overflow-y-auto pr-1 custom-scrollbar min-h-0 mb-6 bg-slate-50/50 rounded-3xl p-3 border border-slate-100">
            <div className="grid grid-cols-1 gap-3">
              {playedWordData.map((data, idx) => (
                <div key={idx} className="bg-white p-5 rounded-2xl border border-indigo-50 flex flex-col gap-3 shadow-sm group hover:border-indigo-200 transition-colors">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] font-black bg-indigo-50 text-indigo-500 px-2 py-1 rounded-lg border border-indigo-100">#{idx + 1}</span>
                      <a 
                        href={`https://hiztegiak.elhuyar.eus/eu/${data.hitza}`} 
                        target="_blank" 
                        rel="noopener noreferrer" 
                        className="text-indigo-950 font-black text-lg uppercase hover:text-indigo-600 transition-colors flex items-center gap-2"
                      >
                        {data.hitza}
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      </a>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {data.sinonimoak.map((sin, sIdx) => (
                      <span key={sIdx} className="bg-indigo-600/5 text-indigo-600 px-3 py-1.5 rounded-xl font-bold text-xs border border-indigo-600/10">
                        {sin}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          
          <div className="shrink-0 pb-2 mb-4">
            <button onClick={() => setStatus(GameStatus.SUMMARY)} className="w-full bg-indigo-600 text-white font-black py-5 rounded-2xl shadow-lg uppercase tracking-widest text-sm active:scale-95 transition-transform">ITXI</button>
          </div>
        </div>
      </div>
    );
  }

  return null;
};

export default App;
