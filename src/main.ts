import "./styles.css";

import {
  type GuessRow,
  type InspectStats,
  type RankedCandidate,
  type Recommendation,
  type TileMark,
  compareRecommendations,
  filterCandidates,
  loadWords,
  normalizeWord,
} from "./wordle";
import {
  buildStrategyStatsMap,
  loadStrategyStatsCsv,
  loadStrategyTreeForWord,
  walkStrategyTree,
} from "./strategySupport";
import type { StrategyChild, StrategyEntry, StrategyStatsRow, StrategyTree, StrategyTreeCache } from "./types";

type GridCell = {
  letter: string;
  mark: TileMark;
};

type SolverMessage = {
  type: "info" | "warning" | "error";
  text: string;
};

type AppState = {
  solutions: string[];
  guesses: string[];
  grid: GridCell[][];
  selectedRow: number;
  selectedCol: number;
  controlsOpen: boolean;
  candidates: string[];
  rankedCandidates: RankedCandidate[];
  recommendations: DisplayRecommendation[];
  messages: SolverMessage[];
  loading: boolean;
  calculating: boolean;
  progressProcessed: number;
  progressTotal: number;
  progressLabel: string;
  error: string;
  hasCalculated: boolean;
  inspectWord: string;
  inspectLoading: boolean;
  inspectError: string;
  inspectStats: InspectStats | null;
  inspectSource: "solver" | "strategy_stats" | null;
  inspectStrategyRow: StrategyStatsRow | null;
  activeLeftTab: LeftPanelTab;
};

type WorkerHeuristicProgressMessage = {
  type: "heuristic_progress";
  processed: number;
  total: number;
  topRecommendations: Recommendation[];
};

type WorkerHeuristicDoneMessage = {
  type: "heuristic_done";
  topRecommendations: Recommendation[];
};

type WorkerRefineProgressMessage = {
  type: "refine_progress";
  rootGuess: string;
  processedBuckets: number;
  totalBuckets: number;
  recommendation: Recommendation;
  rankedCandidates: RankedCandidate[];
};

type WorkerRefineDoneMessage = {
  type: "refine_done";
  rootGuess: string;
  recommendation: Recommendation;
  rankedCandidates: RankedCandidate[];
};

type WorkerInspectDoneMessage = {
  type: "inspect_done";
  stats: InspectStats;
};

type WorkerErrorMessage = {
  type: "error";
  error: string;
};

type WorkerToMainMessage =
  | WorkerHeuristicProgressMessage
  | WorkerHeuristicDoneMessage
  | WorkerRefineProgressMessage
  | WorkerRefineDoneMessage
  | WorkerInspectDoneMessage
  | WorkerErrorMessage;

type LeftPanelTab = "remaining" | "letter_positions";

type LetterPositionEntry = {
  letter: string;
  positions: [number, number, number, number, number];
  occurrenceTotal: number;
  wordCount: number;
};

type RecommendationSource = "calculator" | "opening_stats" | "strategy_tree";

type DisplayRecommendation = Recommendation & {
  source: RecommendationSource;
  file?: string;
  note?: string;
};

const DISPLAY_GUESSES = 30;
const ROWS = 6;
const COLS = 5;

const state: AppState = {
  solutions: [],
  guesses: [],
  grid: createEmptyGrid(),
  selectedRow: 0,
  selectedCol: 0,
  controlsOpen: false,
  candidates: [],
  rankedCandidates: [],
  recommendations: [],
  messages: [],
  loading: true,
  calculating: false,
  progressProcessed: 0,
  progressTotal: 0,
  progressLabel: "",
  error: "",
  hasCalculated: false,
  inspectWord: "",
  inspectLoading: false,
  inspectError: "",
  inspectStats: null,
  inspectSource: null,
  inspectStrategyRow: null,
  activeLeftTab: "remaining",
};

let calculationRunId = 0;
let strategyEntries: StrategyEntry[] = [];
let strategyStatsRows: StrategyStatsRow[] = [];
let strategyStatsByWord = new Map<string, StrategyStatsRow>();
const strategyTreeCache: StrategyTreeCache = new Map();
let solutionWordSet = new Set<string>();

let liveStrategyPreview: DisplayRecommendation | null = null;
let liveStrategyPreviewSignature = "";
let liveStrategyPreviewRunId = 0;

let inspectRunId = 0;

let heuristicWorker: Worker | null = null;
let refineWorkers: Worker[] = [];
let inspectWorker: Worker | null = null;

let rootRecommendationMap = new Map<string, DisplayRecommendation>();
let rootDepthMap = new Map<string, RankedCandidate[]>();
let refineQueue: string[] = [];
let activeRefineProgress = new Map<string, number>();
let heuristicProcessedCount = 0;
let completedRoots = 0;

const appElement = document.querySelector<HTMLDivElement>("#app");

if (!appElement) {
  throw new Error("Missing #app element.");
}

const app: HTMLDivElement = appElement;

const KEYBOARD_ROWS = [
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["enter", "z", "x", "c", "v", "b", "n", "m", "backspace"],
];

const MARK_ORDER: TileMark[] = ["unknown", "absent", "present", "correct"];

function createEmptyGrid(): GridCell[][] {
  return Array.from({ length: ROWS }, () =>
    Array.from({ length: COLS }, () => ({
      letter: "",
      mark: "unknown" as TileMark,
    }))
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#039;";
      default:
        return char;
    }
  });
}

function tileMarkToFeedbackColor(mark: TileMark): "B" | "Y" | "G" | null {
  if (mark === "absent") return "B";
  if (mark === "present") return "Y";
  if (mark === "correct") return "G";
  return null;
}

function guessRowToFeedbackPattern(row: GuessRow): string | null {
  const chars = row.marks.map(tileMarkToFeedbackColor);
  return chars.every((value) => value !== null) ? chars.join("") : null;
}

function makeDisplayRecommendation(
  base: Recommendation,
  source: RecommendationSource,
  extras: Partial<DisplayRecommendation> = {}
): DisplayRecommendation {
  return {
    ...base,
    source,
    ...extras,
  };
}

function makeStrategyBackedRecommendation(
  guess: string,
  source: RecommendationSource,
  statsRow: StrategyStatsRow | null = null
): DisplayRecommendation {
  const normalized = guess.toLowerCase();

  return {
    guess: normalized,
    possibleAnswer: solutionWordSet.has(normalized),
    exact: true,
    worstTurns:
      typeof statsRow?.maximum_guesses === "number" ? statsRow.maximum_guesses : Number.NaN,
    expectedTurns:
      typeof statsRow?.expected_guesses === "number" ? statsRow.expected_guesses : Number.NaN,
    entropy: Number.NaN,
    expectedRemaining: Number.NaN,
    worstBucket: Number.NaN,
    singletonCount: 0,
    splitCount: 0,
    source,
    file: typeof statsRow?.file === "string" ? statsRow.file : undefined,
    note: statsRow ? `From ${statsRow.starting_word}` : undefined,
  };
}

function buildOpeningStatsMessages(incompleteRows: number[]): SolverMessage[] {
  const messages: SolverMessage[] = [];

  if (incompleteRows.length > 0) {
    messages.push({
      type: "warning",
      text: `Incomplete rows are ignored until all 5 letters are filled: ${incompleteRows.join(", ")}.`,
    });
  }

  messages.push({
    type: "info",
    text: "Showing opening guesses ranked from strategy_stats.csv using a weighted combo of low expected and low maximum guesses.",
  });

  return messages;
}

function buildOpeningStatsRecommendations(limit = DISPLAY_GUESSES): DisplayRecommendation[] {
  const validRows = strategyStatsRows.filter((row) => {
    const word = typeof row.starting_word === "string" ? row.starting_word.trim() : "";
    const expected = Number(row.expected_guesses);
    const maximum = Number(row.maximum_guesses);

    return word.length === 5 && Number.isFinite(expected) && Number.isFinite(maximum);
  });

  if (validRows.length === 0) {
    return [];
  }

  const expectedValues = validRows.map((row) => Number(row.expected_guesses));
  const maxValues = validRows.map((row) => Number(row.maximum_guesses));

  const minExpected = Math.min(...expectedValues);
  const maxExpected = Math.max(...expectedValues);
  const minMax = Math.min(...maxValues);
  const maxMax = Math.max(...maxValues);

  const normalize = (value: number, min: number, max: number): number => {
    if (max <= min) return 0;
    return (value - min) / (max - min);
  };

  const EXPECTED_WEIGHT = 0.7;
  const MAX_WEIGHT = 0.3;

  return [...validRows]
    .sort((a, b) => {
      const aExpected = Number(a.expected_guesses);
      const bExpected = Number(b.expected_guesses);
      const aMax = Number(a.maximum_guesses);
      const bMax = Number(b.maximum_guesses);

      const aScore =
        EXPECTED_WEIGHT * normalize(aExpected, minExpected, maxExpected) +
        MAX_WEIGHT * normalize(aMax, minMax, maxMax);

      const bScore =
        EXPECTED_WEIGHT * normalize(bExpected, minExpected, maxExpected) +
        MAX_WEIGHT * normalize(bMax, minMax, maxMax);

      return (
        aScore - bScore ||
        aExpected - bExpected ||
        aMax - bMax ||
        a.starting_word.localeCompare(b.starting_word)
      );
    })
    .slice(0, limit)
    .map((row) => makeStrategyBackedRecommendation(row.starting_word, "opening_stats", row));
}

function buildTreeRankedCandidate(word: string, solveDepth: number): RankedCandidate {
  const normalized = word.toLowerCase();

  return {
    recommendation: {
      guess: normalized,
      possibleAnswer: true,
      exact: true,
      worstTurns: solveDepth,
      expectedTurns: solveDepth,
      entropy: Number.NaN,
      expectedRemaining: Number.NaN,
      worstBucket: Number.NaN,
      singletonCount: 0,
      splitCount: 0,
    },
    solveDepth,
  };
}

function isStrategyLinkChild(
  child: StrategyChild
): child is Extract<StrategyChild, { to: string }> {
  return "to" in child;
}

function findStrategyContinuationNode(
  tree: StrategyTree,
  activeRows: GuessRow[]
): { nextNodeId: string | null; terminal: boolean; matchedDepth: number } | null {
  if (activeRows.length === 0) {
    return { nextNodeId: tree.rootId, terminal: false, matchedDepth: 0 };
  }

  let currentNodeId = tree.rootId;

  for (let index = 0; index < activeRows.length; index++) {
    const node = tree.nodes[currentNodeId];
    const row = activeRows[index];
    const pattern = guessRowToFeedbackPattern(row);

    if (!node || node.w !== row.word.toUpperCase() || !pattern) {
      return null;
    }

    const child = node.c[pattern];
    if (!child) {
      return null;
    }

    if ("term" in child && child.term) {
      return {
        nextNodeId: null,
        terminal: true,
        matchedDepth: index + 1,
      };
    }

    if (!isStrategyLinkChild(child)) {
      return null;
    }

    currentNodeId = child.to;
  }

  return {
    nextNodeId: currentNodeId,
    terminal: false,
    matchedDepth: activeRows.length,
  };
}

function collectTreeContinuationState(
  tree: StrategyTree,
  nextNodeId: string,
  matchedDepth: number
): { candidates: string[]; rankedCandidates: RankedCandidate[] } {
  const answerToDepth = new Map<string, number>();
  const visited = new Set<string>();

  function visit(nodeId: string): void {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);

    const node = tree.nodes[nodeId];
    if (!node) {
      return;
    }

    for (const [pattern, child] of Object.entries(node.c)) {
      if (pattern === "GGGGG" && "term" in child && child.term) {
        const answer = node.w.toLowerCase();
        const relativeDepth = Math.max(1, child.turn - matchedDepth);
        const existing = answerToDepth.get(answer);

        if (existing === undefined || relativeDepth < existing) {
          answerToDepth.set(answer, relativeDepth);
        }
        continue;
      }

      if ("to" in child) {
        visit(child.to);
      }
    }
  }

  visit(nextNodeId);

  const candidates = [...answerToDepth.keys()].sort();
  const rankedCandidates = [...answerToDepth.entries()]
    .map(([word, solveDepth]) => buildTreeRankedCandidate(word, solveDepth))
    .sort((a, b) => {
      if (a.solveDepth !== b.solveDepth) {
        return a.solveDepth - b.solveDepth;
      }

      return a.recommendation.guess.localeCompare(b.recommendation.guess);
    });

  return { candidates, rankedCandidates };
}

async function tryStrategyTreeRecommendation(
  activeRows: GuessRow[]
): Promise<{
  recommendation: DisplayRecommendation | null;
  terminal: boolean;
  candidates: string[] | null;
  rankedCandidates: RankedCandidate[] | null;
}> {
  if (activeRows.length === 0) {
    return { recommendation: null, terminal: false, candidates: null, rankedCandidates: null };
  }

  const firstGuess = activeRows[0].word.toUpperCase();
  const statsRow = strategyStatsByWord.get(firstGuess) ?? null;

  if (!statsRow || strategyEntries.length === 0) {
    return { recommendation: null, terminal: false, candidates: null, rankedCandidates: null };
  }

  const patterns = activeRows.map((row) => guessRowToFeedbackPattern(row));
  if (patterns.some((pattern) => pattern === null)) {
    return { recommendation: null, terminal: false, candidates: null, rankedCandidates: null };
  }

  const tree = await loadStrategyTreeForWord(firstGuess, strategyEntries, strategyTreeCache);
  if (!tree) {
    return { recommendation: null, terminal: false, candidates: null, rankedCandidates: null };
  }

  const walk = walkStrategyTree(
    tree,
    activeRows.map((row, index) => ({
      word: row.word,
      pattern: patterns[index],
    })),
    statsRow
  );

  if (walk.source !== "tree" || walk.error) {
    return { recommendation: null, terminal: false, candidates: null, rankedCandidates: null };
  }

  const continuation = findStrategyContinuationNode(tree, activeRows);
  if (!continuation) {
    return { recommendation: null, terminal: false, candidates: null, rankedCandidates: null };
  }

  if (continuation.terminal || walk.terminal || !walk.nextWord || !continuation.nextNodeId) {
    return {
      recommendation: null,
      terminal: true,
      candidates: null,
      rankedCandidates: null,
    };
  }

  const treeState = collectTreeContinuationState(
    tree,
    continuation.nextNodeId,
    continuation.matchedDepth
  );

  return {
    recommendation: makeStrategyBackedRecommendation(walk.nextWord, "strategy_tree", statsRow),
    terminal: false,
    candidates: treeState.candidates,
    rankedCandidates: treeState.rankedCandidates,
  };
}

function recommendationTypeLabel(item: DisplayRecommendation): string {
  if (item.source === "opening_stats") return "Stats";
  if (item.source === "strategy_tree") return "Tree";
  return item.possibleAnswer ? "Ans" : "Probe";
}

function formatTurns(value: number, exact: boolean): string {
  return Number.isFinite(value) ? value.toFixed(exact ? 0 : 1) : "—";
}

function formatFixed(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

function formatIntegerLike(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value)) : "—";
}

function buildStrategyEntriesFromStats(rows: StrategyStatsRow[]): StrategyEntry[] {
  const deduped = new Map<string, StrategyEntry>();

  for (const row of rows) {
    if (typeof row.file !== "string" || !row.file.trim()) {
      continue;
    }

    const key = row.starting_word.toUpperCase();
    deduped.set(key, {
      name: key,
      file: row.file,
      sizeBytes: 0,
      updatedAt: "",
    });
  }

  return [...deduped.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function buildLiveStrategyPreviewSignature(): string {
  if (state.loading || state.calculating) {
    return "busy";
  }

  const activeRows = getActiveRows();
  if (activeRows.length === 0) {
    return "";
  }

  return activeRows
    .map((row) => {
      const pattern = row.marks
        .map((mark) => tileMarkToFeedbackColor(mark) ?? "U")
        .join("");
      return `${row.word}:${pattern}`;
    })
    .join("|");
}

function sameDisplayRecommendation(
  a: DisplayRecommendation | null,
  b: DisplayRecommendation | null
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;

  return (
    a.guess === b.guess &&
    a.source === b.source &&
    a.worstTurns === b.worstTurns &&
    a.expectedTurns === b.expectedTurns &&
    a.file === b.file &&
    a.note === b.note
  );
}

function getRenderedRecommendations(): DisplayRecommendation[] {
  if (!liveStrategyPreview) {
    return state.recommendations;
  }

  const remaining = state.recommendations.filter(
    (item) => !(item.guess === liveStrategyPreview!.guess && item.source === liveStrategyPreview!.source)
  );

  return [liveStrategyPreview, ...remaining].slice(0, DISPLAY_GUESSES);
}

async function refreshLiveStrategyPreviewIfNeeded(): Promise<void> {
  const signature = buildLiveStrategyPreviewSignature();

  if (signature === liveStrategyPreviewSignature) {
    return;
  }

  liveStrategyPreviewSignature = signature;
  const runId = ++liveStrategyPreviewRunId;

  if (!signature || signature === "busy") {
    const hadPreview = liveStrategyPreview !== null;
    liveStrategyPreview = null;
    if (hadPreview) {
      render();
    }
    return;
  }

  const activeRows = getActiveRows();
  const strategyResult = await tryStrategyTreeRecommendation(activeRows);

  if (runId !== liveStrategyPreviewRunId) {
    return;
  }

  const nextPreview =
    strategyResult.recommendation && !strategyResult.terminal
      ? strategyResult.recommendation
      : null;

  if (!sameDisplayRecommendation(liveStrategyPreview, nextPreview)) {
    liveStrategyPreview = nextPreview;
    render();
  }
}

function cleanupWorkers(): void {
  if (heuristicWorker) {
    heuristicWorker.terminate();
    heuristicWorker = null;
  }

  for (const worker of refineWorkers) {
    worker.terminate();
  }

  refineWorkers = [];
}

function cleanupInspectWorker(): void {
  if (inspectWorker) {
    inspectWorker.terminate();
    inspectWorker = null;
  }
}

function rebuildRecommendations(): void {
  state.recommendations = [...rootRecommendationMap.values()].sort(compareRecommendations);
}

function updateRankedCandidatesFromBestRefinedRoot(): void {
  const sorted = [...rootRecommendationMap.values()].sort(compareRecommendations);

  for (const rec of sorted) {
    const ranked = rootDepthMap.get(rec.guess);

    if (ranked) {
      state.rankedCandidates = ranked;
      return;
    }
  }

  state.rankedCandidates = [];
}

function updateProgressDisplay(): void {
  const activeFraction = [...activeRefineProgress.values()].reduce((sum, value) => sum + value, 0);
  state.progressProcessed = heuristicProcessedCount + completedRoots + activeFraction;
  state.progressTotal = state.guesses.length + DISPLAY_GUESSES;
}

function startNextRefineJob(worker: Worker, runId: number): void {
  const nextRoot = refineQueue.shift();

  if (!nextRoot) {
    return;
  }

  activeRefineProgress.set(nextRoot, 0);
  updateProgressDisplay();
  state.progressLabel = `Refining ${nextRoot.toUpperCase()}...`;
  render();

  worker.postMessage({
    type: "refine",
    candidates: state.candidates,
    guesses: state.guesses,
    rootGuess: nextRoot,
  });

  worker.onmessage = (event: MessageEvent<WorkerToMainMessage>) => {
    if (runId !== calculationRunId) {
      return;
    }

    const message = event.data;

    if (message.type === "refine_progress") {
      rootRecommendationMap.set(message.rootGuess, makeDisplayRecommendation(message.recommendation, "calculator"));
      rootDepthMap.set(message.rootGuess, message.rankedCandidates);

      const fraction =
        message.totalBuckets > 0 ? message.processedBuckets / message.totalBuckets : 0;

      activeRefineProgress.set(message.rootGuess, fraction);

      rebuildRecommendations();
      updateRankedCandidatesFromBestRefinedRoot();
      updateProgressDisplay();
      state.progressLabel = `Refining ${message.rootGuess.toUpperCase()}...`;
      render();
      return;
    }

    if (message.type === "refine_done") {
      rootRecommendationMap.set(message.rootGuess, makeDisplayRecommendation(message.recommendation, "calculator"));
      rootDepthMap.set(message.rootGuess, message.rankedCandidates);
      activeRefineProgress.delete(message.rootGuess);
      completedRoots++;

      rebuildRecommendations();
      updateRankedCandidatesFromBestRefinedRoot();
      updateProgressDisplay();

      if (refineQueue.length > 0) {
        state.progressLabel = `Refined ${message.rootGuess.toUpperCase()}. Continuing...`;
        render();
        startNextRefineJob(worker, runId);
      } else {
        const allDone =
          completedRoots >= Math.min(DISPLAY_GUESSES, rootRecommendationMap.size);

        if (allDone) {
          state.progressLabel = "Done";
          state.calculating = false;
          activeRefineProgress.clear();
          updateProgressDisplay();
          render();
        } else {
          render();
        }
      }

      return;
    }

    if (message.type === "error") {
      state.error = message.error;
      state.calculating = false;
      cleanupWorkers();
      render();
    }
  };

  worker.onerror = (event) => {
    if (runId !== calculationRunId) {
      return;
    }

    state.error = event.message || "Worker error";
    state.calculating = false;
    cleanupWorkers();
    render();
  };
}

function startRefinePool(shortlisted: Recommendation[], runId: number): void {
  refineQueue = shortlisted.map((item) => item.guess);
  completedRoots = 0;
  activeRefineProgress.clear();

  const workerCount = Math.min(
    refineQueue.length,
    Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))
  );

  refineWorkers = Array.from({ length: workerCount }, () => {
    return new Worker(new URL("./solverWorker.ts", import.meta.url), {
      type: "module",
    });
  });

  if (workerCount === 0) {
    state.calculating = false;
    state.progressLabel = "Done";
    render();
    return;
  }

  for (const worker of refineWorkers) {
    startNextRefineJob(worker, runId);
  }
}

function selectCell(row: number, col: number): void {
  state.selectedRow = Math.max(0, Math.min(ROWS - 1, row));
  state.selectedCol = Math.max(0, Math.min(COLS - 1, col));
}

function getCell(row: number, col: number): GridCell {
  return state.grid[row][col];
}

function rowToWord(row: GridCell[]): string {
  return row.map((cell) => cell.letter).join("");
}

function rowIsComplete(row: GridCell[]): boolean {
  return /^[a-z]{5}$/.test(rowToWord(row));
}

function rowHasAnyLocks(row: GridCell[]): boolean {
  return row.some((cell) => cell.mark !== "unknown");
}

function getActiveRows(): GuessRow[] {
  return state.grid
    .filter((row) => rowIsComplete(row) && rowHasAnyLocks(row))
    .map((row) => ({
      word: rowToWord(row),
      marks: row.map((cell) => cell.mark),
    }));
}

function getFirstIncompleteOrEmptyRowIndex(): number {
  for (let rowIndex = 0; rowIndex < ROWS; rowIndex++) {
    const filledCount = state.grid[rowIndex].filter((cell) => Boolean(cell.letter)).length;
    if (filledCount < COLS) {
      return rowIndex;
    }
  }

  return ROWS - 1;
}

function getIncompleteRowNumbers(): number[] {
  return state.grid.flatMap((row, index) => {
    const filledCount = row.filter((cell) => Boolean(cell.letter)).length;
    return filledCount > 0 && filledCount < COLS ? [index + 1] : [];
  });
}

function setCellLetter(row: number, col: number, letter: string): void {
  selectCell(row, col);

  const cell = getCell(row, col);
  cell.letter = letter.toLowerCase();
  cell.mark = cell.mark ?? "unknown";

  if (state.selectedCol < COLS - 1) {
    state.selectedCol++;
  }

  render();
}

function appendLetter(letter: string): void {
  setCellLetter(state.selectedRow, state.selectedCol, letter);
}

function deleteLetter(): void {
  let row = state.selectedRow;
  let col = state.selectedCol;
  let cell = getCell(row, col);

  if (!cell.letter && col > 0) {
    col--;
    selectCell(row, col);
    cell = getCell(row, col);
  }

  cell.letter = "";
  cell.mark = "unknown";

  render();
}

function cycleMark(row: number, col: number, direction: 1 | -1): void {
  selectCell(row, col);

  const cell = getCell(row, col);

  if (!cell.letter) {
    render();
    return;
  }

  const currentIndex = MARK_ORDER.indexOf(cell.mark);
  const nextIndex =
    (currentIndex + direction + MARK_ORDER.length) % MARK_ORDER.length;

  cell.mark = MARK_ORDER[nextIndex];
  render();
}

function setRowWord(word: string): void {
  const clean = normalizeWord(word).replace(/[^a-z]/g, "").slice(0, 5);
  const row = state.grid[state.selectedRow];

  for (let col = 0; col < COLS; col++) {
    row[col].letter = clean[col] ?? "";
    row[col].mark = "unknown";
  }

  state.selectedCol = Math.min(clean.length, COLS - 1);
  render();
}

function clearSelectedRowMarks(): void {
  for (const cell of state.grid[state.selectedRow]) {
    cell.mark = "unknown";
  }

  render();
}

function removeLastFilledRow(): void {
  for (let rowIndex = ROWS - 1; rowIndex >= 0; rowIndex--) {
    const row = state.grid[rowIndex];

    if (row.some((cell) => cell.letter || cell.mark !== "unknown")) {
      state.grid[rowIndex] = Array.from({ length: COLS }, () => ({
        letter: "",
        mark: "unknown" as TileMark,
      }));

      selectCell(rowIndex, 0);
      render();
      return;
    }
  }
}

function resetGame(): void {
  calculationRunId++;
  cleanupWorkers();

  state.grid = createEmptyGrid();
  state.selectedRow = 0;
  state.selectedCol = 0;
  state.candidates = [...state.solutions];
  state.rankedCandidates = [];
  state.recommendations = [];
  state.messages = [];
  state.hasCalculated = false;
  state.calculating = false;
  state.progressProcessed = 0;
  state.progressTotal = 0;
  state.progressLabel = "";
  state.error = "";

  liveStrategyPreview = null;
  liveStrategyPreviewSignature = "";

  rootRecommendationMap.clear();
  rootDepthMap.clear();
  refineQueue = [];
  activeRefineProgress.clear();
  heuristicProcessedCount = 0;
  completedRoots = 0;

  render();
}

function handleVirtualKey(key: string): void {
  if (key === "enter") {
    void calculateGuesses();
    return;
  }

  if (key === "backspace") {
    deleteLetter();
    return;
  }

  if (/^[a-z]$/.test(key)) {
    appendLetter(key);
  }
}

function buildMessages(
  activeRows: GuessRow[],
  incompleteRows: number[],
  candidates: string[]
): SolverMessage[] {
  const messages: SolverMessage[] = [];

  if (incompleteRows.length > 0) {
    messages.push({
      type: "warning",
      text: `Incomplete rows are ignored until all 5 letters are filled: ${incompleteRows.join(", ")}.`,
    });
  }

  if (activeRows.length === 0) {
    messages.push({
      type: "info",
      text: "Fill one or more complete rows, then press Calculate Guesses.",
    });
    return messages;
  }

  if (candidates.length === 0) {
    messages.push({
      type: "error",
      text: "Contradiction detected: no possible answers match the current rows.",
    });
    return messages;
  }

  if (candidates.length === 1) {
    messages.push({
      type: "info",
      text: `Only one answer fits: ${candidates[0].toUpperCase()}.`,
    });
  }

  return messages;
}

function buildOpeningFallbackMessages(incompleteRows: number[]): SolverMessage[] {
  const messages: SolverMessage[] = [];

  if (incompleteRows.length > 0) {
    messages.push({
      type: "warning",
      text: `Incomplete rows are ignored until all 5 letters are filled: ${incompleteRows.join(", ")}.`,
    });
  }

  messages.push({
    type: "warning",
    text: "strategy_stats.csv was not found or had no valid rows. Falling back to calculator output.",
  });

  return messages;
}

async function calculateGuesses(): Promise<void> {
  if (state.loading || state.calculating) return;

  const runId = ++calculationRunId;
  cleanupWorkers();

  selectCell(getFirstIncompleteOrEmptyRowIndex(), 0);

  const activeRows = getActiveRows();
  const incompleteRows = getIncompleteRowNumbers();

  state.candidates = filterCandidates(state.solutions, activeRows);
  state.error = "";

  if (activeRows.length === 0) {
    state.messages =
      strategyStatsRows.length > 0
        ? buildOpeningStatsMessages(incompleteRows)
        : buildOpeningFallbackMessages(incompleteRows);

    state.recommendations =
      strategyStatsRows.length > 0
        ? buildOpeningStatsRecommendations(DISPLAY_GUESSES)
        : [];

    state.rankedCandidates = [];
    state.hasCalculated = true;
    state.progressProcessed = 0;
    state.progressTotal = 0;
    state.progressLabel = "";

    if (strategyStatsRows.length > 0) {
      state.calculating = false;
      render();
      return;
    }
  }

  if (activeRows.length === 0 && strategyStatsRows.length === 0) {
    state.calculating = true;
    state.progressProcessed = 0;
    state.progressTotal = state.guesses.length + DISPLAY_GUESSES;
    state.progressLabel = "Scanning guesses...";
  }

  state.messages = buildMessages(activeRows, incompleteRows, state.candidates);
  state.rankedCandidates = [];
  state.recommendations = [];
  state.hasCalculated = true;
  state.progressProcessed = 0;
  state.progressTotal = 0;
  state.progressLabel = "";

  if (state.candidates.length === 0) {
    state.calculating = false;
    render();
    return;
  }

  const strategyResult = await tryStrategyTreeRecommendation(activeRows);
  if (runId !== calculationRunId) {
    return;
  }

  if (strategyResult.terminal) {
    state.messages = [
      ...state.messages,
      {
        type: "info",
        text: "Precomputed strategy tree already resolves this line.",
      },
    ];
    state.candidates = strategyResult.candidates ?? state.candidates;
    state.rankedCandidates = strategyResult.rankedCandidates ?? [];
    state.recommendations = [];
    state.calculating = false;
    render();
    return;
  }

  if (strategyResult.recommendation) {
    state.messages = [
      ...state.messages,
      {
        type: "info",
        text: `Following precomputed strategy tree from ${activeRows[0].word.toUpperCase()}.`,
      },
    ];
    state.candidates = strategyResult.candidates ?? state.candidates;
    state.rankedCandidates = strategyResult.rankedCandidates ?? [];
    state.recommendations = [strategyResult.recommendation];
    state.calculating = false;
    render();
    return;
  }

  state.calculating = true;
  state.progressProcessed = 0;
  state.progressTotal = state.guesses.length + DISPLAY_GUESSES;
  state.progressLabel = "Scanning guesses...";

  rootRecommendationMap.clear();
  rootDepthMap.clear();
  refineQueue = [];
  activeRefineProgress.clear();
  heuristicProcessedCount = 0;
  completedRoots = 0;

  render();

  const worker = new Worker(new URL("./solverWorker.ts", import.meta.url), {
    type: "module",
  });

  heuristicWorker = worker;

  worker.onmessage = (event: MessageEvent<WorkerToMainMessage>) => {
    if (runId !== calculationRunId || worker !== heuristicWorker) {
      return;
    }

    const message = event.data;

    if (message.type === "heuristic_progress") {
      heuristicProcessedCount = message.processed;

      rootRecommendationMap.clear();
      for (const rec of message.topRecommendations) {
        rootRecommendationMap.set(rec.guess, makeDisplayRecommendation(rec, "calculator"));
      }

      rebuildRecommendations();
      updateRankedCandidatesFromBestRefinedRoot();
      updateProgressDisplay();
      state.progressLabel = "Scanning guesses...";
      render();
      return;
    }

    if (message.type === "heuristic_done") {
      heuristicProcessedCount = state.guesses.length;

      rootRecommendationMap.clear();
      for (const rec of message.topRecommendations) {
        rootRecommendationMap.set(rec.guess, makeDisplayRecommendation(rec, "calculator"));
      }

      rebuildRecommendations();
      updateProgressDisplay();
      state.progressLabel = "Refining top roots...";
      render();

      worker.terminate();
      heuristicWorker = null;

      startRefinePool(message.topRecommendations, runId);
      return;
    }

    if (message.type === "error") {
      state.error = message.error;
      state.calculating = false;
      cleanupWorkers();
      render();
    }
  };

  worker.onerror = (event) => {
    if (runId !== calculationRunId || worker !== heuristicWorker) {
      return;
    }

    state.error = event.message || "Worker error";
    state.calculating = false;
    cleanupWorkers();
    render();
  };

  worker.postMessage({
    type: "heuristic",
    candidates: state.candidates,
    guesses: state.guesses,
    topN: DISPLAY_GUESSES,
  });
}

function inspectWordStats(): void {
  if (state.loading) return;

  const runId = ++inspectRunId;
  cleanupInspectWorker();

  const guess = normalizeWord(state.inspectWord).replace(/[^a-z]/g, "").slice(0, 5);
  state.inspectWord = guess;
  state.inspectError = "";
  state.inspectStats = null;
  state.inspectSource = null;
  state.inspectStrategyRow = null;

  if (!/^[a-z]{5}$/.test(guess)) {
    state.inspectError = "Enter a 5-letter word.";
    render();
    return;
  }

  const activeRows = getActiveRows();
  const statsRow = strategyStatsByWord.get(guess.toUpperCase()) ?? null;

  if (activeRows.length === 0 && statsRow) {
    state.inspectLoading = false;
    state.inspectSource = "strategy_stats";
    state.inspectStrategyRow = statsRow;
    render();
    return;
  }

  state.inspectLoading = true;
  render();

  const worker = new Worker(new URL("./solverWorker.ts", import.meta.url), {
    type: "module",
  });

  inspectWorker = worker;

  worker.onmessage = (event: MessageEvent<WorkerToMainMessage>) => {
    if (runId !== inspectRunId || worker !== inspectWorker) {
      return;
    }

    const message = event.data;

    if (message.type === "inspect_done") {
      state.inspectStats = message.stats;
      state.inspectSource = "solver";
      state.inspectStrategyRow = null;
      state.inspectLoading = false;
      cleanupInspectWorker();
      render();
      return;
    }

    if (message.type === "error") {
      state.inspectError = message.error;
      state.inspectLoading = false;
      cleanupInspectWorker();
      render();
    }
  };

  worker.onerror = (event) => {
    if (runId !== inspectRunId || worker !== inspectWorker) {
      return;
    }

    state.inspectError = event.message || "Inspector worker error";
    state.inspectLoading = false;
    cleanupInspectWorker();
    render();
  };

  worker.postMessage({
    type: "inspect",
    candidates: state.hasCalculated ? state.candidates : state.solutions,
    guesses: state.guesses,
    guess,
  });
}

function classForMark(mark: TileMark): string {
  if (mark === "correct") return "tile tile-correct";
  if (mark === "present") return "tile tile-present";
  if (mark === "absent") return "tile tile-absent";
  return "tile tile-empty";
}

function labelForMark(mark: TileMark): string {
  if (mark === "correct") return "correct";
  if (mark === "present") return "present";
  if (mark === "absent") return "absent";
  return "unknown";
}

function getNiceChartTicks(maxValue: number): number[] {
  if (maxValue <= 0) {
    return [0, 1];
  }

  const rawTicks = [
    0,
    Math.round(maxValue * 0.25),
    Math.round(maxValue * 0.5),
    Math.round(maxValue * 0.75),
    maxValue,
  ];

  return [...new Set(rawTicks)].sort((a, b) => a - b);
}

function renderMessages(): string {
  if (state.messages.length === 0) return "";

  return `
    <div class="message-stack">
      ${state.messages
        .map(
          (message) => `
            <div class="solver-message solver-message-${message.type}">
              ${escapeHtml(message.text)}
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderWordleBoard(): string {
  return `
    <div class="wordle-board">
      ${state.grid
        .map(
          (row, rowIndex) => `
            <div class="board-row">
              ${row
                .map((cell, colIndex) => {
                  const selected =
                    rowIndex === state.selectedRow && colIndex === state.selectedCol;

                  return `
                    <button
                      class="board-tile input-board-tile ${classForMark(cell.mark)} ${
                        selected ? "selected-tile" : ""
                      }"
                      data-cell-row="${rowIndex}"
                      data-cell-col="${colIndex}"
                      title="Click to select. When selected, click/right-click/scroll to cycle state."
                      aria-label="Row ${rowIndex + 1}, column ${colIndex + 1}, ${labelForMark(cell.mark)}"
                    >
                      ${cell.letter.toUpperCase()}
                    </button>
                  `;
                })
                .join("")}
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function getKeyboardMarks(): Record<string, TileMark> {
  const result: Record<string, TileMark> = {};
  const priority: Record<TileMark, number> = {
    unknown: 0,
    absent: 1,
    present: 2,
    correct: 3,
  };

  for (const row of state.grid) {
    for (const cell of row) {
      if (!cell.letter || cell.mark === "unknown") continue;

      const existing = result[cell.letter] ?? "unknown";

      if (priority[cell.mark] > priority[existing]) {
        result[cell.letter] = cell.mark;
      }
    }
  }

  return result;
}

function renderKeyboard(): string {
  const marks = getKeyboardMarks();

  return `
    <div class="keyboard">
      ${KEYBOARD_ROWS.map(
        (row) => `
          <div class="keyboard-row">
            ${row
              .map((key) => {
                const mark = key.length === 1 ? marks[key] ?? "unknown" : "unknown";
                const className =
                  key.length === 1 ? `key ${classForMark(mark)}` : "key key-wide";

                const label = key === "backspace" ? "BACK" : key.toUpperCase();

                return `
                  <button class="${className}" data-key="${key}">
                    ${label}
                  </button>
                `;
              })
              .join("")}
          </div>
        `
      ).join("")}
    </div>
  `;
}

function getCandidateStyle(steps: number, minSteps: number, maxSteps: number): string {
  const range = Math.max(1, maxSteps - minSteps);
  const t = (steps - minSteps) / range;
  const hue = 120 - 120 * t;

  return `
    background: linear-gradient(
      90deg,
      hsla(${hue.toFixed(1)}, 82%, 58%, 0.22) 0%,
      rgba(255, 255, 255, 0.98) 88%
    );
    border-color: hsla(${hue.toFixed(1)}, 68%, 24%, 0.58);
  `;
}

function getLetterPositionEntries(words: string[]): LetterPositionEntry[] {
  const positionCounts = Array.from({ length: 26 }, () => [0, 0, 0, 0, 0] as [
    number,
    number,
    number,
    number,
    number
  ]);
  const wordCounts = Array.from({ length: 26 }, () => 0);

  for (const word of words) {
    const seenInWord = new Set<number>();

    for (let i = 0; i < 5 && i < word.length; i++) {
      const code = word.charCodeAt(i) - 97;

      if (code >= 0 && code < 26) {
        positionCounts[code][i]++;
        seenInWord.add(code);
      }
    }

    for (const code of seenInWord) {
      wordCounts[code]++;
    }
  }

  return positionCounts.map((positions, index) => ({
    letter: String.fromCharCode(65 + index),
    positions,
    occurrenceTotal: positions.reduce((sum, value) => sum + value, 0),
    wordCount: wordCounts[index],
  }));
}

function renderLetterPositionChart(): string {
  if (state.candidates.length === 0) {
    return `<div class="empty warning">No candidates remain.</div>`;
  }

  const entries = getLetterPositionEntries(state.candidates);
  const totalWords = Math.max(1, state.candidates.length);
  const chartMax = totalWords;
  const ticks = getNiceChartTicks(chartMax);

  const makeSegment = (
    count: number,
    className: string,
    wordCount: number
  ): string => {
    if (count <= 0 || wordCount <= 0) {
      return "";
    }

    const percentOfWordsWithLetter = ((count / wordCount) * 100).toFixed(2);

    return `
      <div
        class="letter-bar-segment ${className}"
        style="flex: ${count}"
        data-chart-tooltip="${escapeHtml(`${percentOfWordsWithLetter}%`)}"
      ></div>
    `;
  };

  return `
    <div class="left-panel-tab-content letter-chart-wrap">
      <div class="letter-chart-legend">
        <div class="letter-chart-legend-item">
          <span class="legend-swatch legend-pos-1"></span>
          <span>1st</span>
        </div>
        <div class="letter-chart-legend-item">
          <span class="legend-swatch legend-pos-2"></span>
          <span>2nd</span>
        </div>
        <div class="letter-chart-legend-item">
          <span class="legend-swatch legend-pos-3"></span>
          <span>3rd</span>
        </div>
        <div class="letter-chart-legend-item">
          <span class="legend-swatch legend-pos-4"></span>
          <span>4th</span>
        </div>
        <div class="letter-chart-legend-item">
          <span class="legend-swatch legend-pos-5"></span>
          <span>5th</span>
        </div>
      </div>

      <div class="letter-chart-scroll">
        <div class="letter-chart-grid">
          <div class="letter-chart-y-axis">
            ${ticks
              .slice()
              .reverse()
              .map(
                (tick) => `
                  <div class="letter-chart-y-tick">
                    <span class="letter-chart-y-label">${tick}</span>
                  </div>
                `
              )
              .join("")}
          </div>

          <div class="letter-chart-plot">
            ${ticks
              .slice()
              .reverse()
              .map(
                (tick) => `
                  <div
                    class="letter-chart-grid-line"
                    style="bottom: ${(tick / chartMax) * 100}%"
                  ></div>
                `
              )
              .join("")}

            <div class="letter-chart">
              ${entries
                .map((entry) => {
                  const barHeight = (entry.wordCount / chartMax) * 100;

                  return `
                    <div class="letter-chart-item">
                      <div class="letter-bar-shell">
                        <div
                          class="letter-bar-stack"
                          style="height: ${barHeight.toFixed(2)}%"
                          aria-label="${escapeHtml(
                            `${entry.letter}: ${entry.wordCount}/${totalWords}`
                          )}"
                        >
                          ${makeSegment(entry.positions[0], "segment-pos-1", entry.wordCount)}
                          ${makeSegment(entry.positions[1], "segment-pos-2", entry.wordCount)}
                          ${makeSegment(entry.positions[2], "segment-pos-3", entry.wordCount)}
                          ${makeSegment(entry.positions[3], "segment-pos-4", entry.wordCount)}
                          ${makeSegment(entry.positions[4], "segment-pos-5", entry.wordCount)}
                        </div>
                      </div>
                      <div class="letter-bar-label">${entry.letter}</div>
                    </div>
                  `;
                })
                .join("")}
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderLeftPanelContent(): string {
  return `
    <div class="left-panel-content">
      <div class="panel-tabs">
        <button
          class="panel-tab ${state.activeLeftTab === "remaining" ? "panel-tab-active" : ""}"
          data-left-tab="remaining"
        >
          Words Remaining
        </button>

        <button
          class="panel-tab ${state.activeLeftTab === "letter_positions" ? "panel-tab-active" : ""}"
          data-left-tab="letter_positions"
        >
          Letter Positions
        </button>
      </div>

      <div class="left-panel-body">
        ${
          state.activeLeftTab === "remaining"
            ? renderCandidatesList()
            : renderLetterPositionChart()
        }
      </div>
    </div>
  `;
}

function renderCandidatesList(): string {
  if (!state.hasCalculated) {
    return `<div class="empty">Press Calculate Guesses after entering your known rows.</div>`;
  }

  if (state.candidates.length === 0) {
    return `<div class="empty warning">No candidates remain.</div>`;
  }

  if (state.rankedCandidates.length === 0) {
    return `
      <div class="side-list">
        ${state.candidates
          .map(
            (word, index) => `
              <button
                class="word-pill ranked-word-pill"
                data-word-choice="${word}"
              >
                <span class="candidate-rank">${index + 1}</span>
                <span class="candidate-word">${word.toUpperCase()}</span>
                <span class="candidate-depth">—</span>
              </button>
            `
          )
          .join("")}
      </div>
    `;
  }

  const minSteps = Math.min(...state.rankedCandidates.map((item) => item.solveDepth));
  const maxSteps = Math.max(...state.rankedCandidates.map((item) => item.solveDepth));

  return `
    <div class="side-list">
      ${state.rankedCandidates
        .map(
          (item, index) => `
            <button
              class="word-pill ranked-word-pill ${index === 0 ? "top-ranked-word" : ""}"
              data-word-choice="${item.recommendation.guess}"
              style="${getCandidateStyle(item.solveDepth, minSteps, maxSteps)}"
            >
              <span class="candidate-rank">${index + 1}</span>
              <span class="candidate-word">${item.recommendation.guess.toUpperCase()}</span>
              <span class="candidate-depth">${item.solveDepth}</span>
            </button>
          `
        )
        .join("")}
    </div>
  `;
}

function renderProgressBar(): string {
  if (!state.calculating && state.progressTotal === 0) {
    return "";
  }

  const total = Math.max(1, state.progressTotal);
  const processed = Math.min(state.progressProcessed, total);
  const percent = (processed / total) * 100;

  return `
    <div class="progress-footer">
      <div class="progress-meta">
        <span>${escapeHtml(state.progressLabel || (state.calculating ? "Calculating..." : "Done"))}</span>
        <span>${processed.toFixed(processed % 1 === 0 ? 0 : 2)} / ${total.toFixed(total % 1 === 0 ? 0 : 2)}</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width: ${percent.toFixed(2)}%;"></div>
      </div>
    </div>
  `;
}

function renderInspectorPanel(): string {
  const stats = state.inspectStats;
  const statsRow = state.inspectStrategyRow;
  const shouldOpen =
    state.inspectLoading ||
    Boolean(state.inspectError) ||
    Boolean(stats) ||
    Boolean(statsRow);

  return `
    <details class="inspect-panel" ${shouldOpen ? "open" : ""}>
      <summary class="inspect-summary"><span class="inspect-summary-label">Check Word</span><span class="inspect-summary-hint">Click to expand</span></summary>
      <div class="inspect-panel-body">
        <div class="inspect-controls">
          <input
            id="inspect-word-input"
            class="inspect-input"
            type="text"
            maxlength="5"
            spellcheck="false"
            autocomplete="off"
            value="${escapeHtml(state.inspectWord)}"
            placeholder="SOARE"
          />
          <button
            id="inspect-word-button"
            class="inspect-button"
            ${state.inspectLoading ? "disabled" : ""}
          >
            ${state.inspectLoading ? "Checking..." : "Check"}
          </button>
        </div>

        ${
          state.inspectError
            ? `<div class="inspect-error">${escapeHtml(state.inspectError)}</div>`
            : ""
        }

        ${
          state.inspectSource === "strategy_stats" && statsRow
            ? `
          <div class="inspect-stats">
            <div><strong>${statsRow.starting_word}</strong> from strategy_stats.csv</div>
            <div>Type: ${solutionWordSet.has(statsRow.starting_word.toLowerCase()) ? "Answer candidate" : "Probe only"}</div>
            <div>Expected guesses: ${formatFixed(Number(statsRow.expected_guesses), 4)}</div>
            <div>Max guesses: ${formatIntegerLike(Number(statsRow.maximum_guesses))}</div>
            <div>Min guesses: ${formatIntegerLike(Number(statsRow.minimum_guesses))}</div>
            <div>Solutions found: ${formatIntegerLike(Number(statsRow.solutions_found))}</div>
            <div>Strategy file: ${escapeHtml(String(statsRow.file ?? "—"))}</div>
          </div>
        `
            : stats
              ? `
          <div class="inspect-stats">
            <div><strong>${stats.guess.toUpperCase()}</strong> on ${stats.candidateCount} candidates</div>
            <div>Type: ${stats.possibleAnswer ? "Answer candidate" : "Probe only"}</div>
            <div>Entropy: ${formatFixed(stats.entropy, 4)}</div>
            <div>Expected remaining: ${formatFixed(stats.expectedRemaining, 2)}</div>
            <div>Worst bucket: ${formatIntegerLike(stats.worstBucket)}</div>
            <div>Singletons: ${formatIntegerLike(stats.singletonCount)}</div>
            <div>Splits: ${formatIntegerLike(stats.splitCount)}</div>
            <div>Heuristic worst: ${formatFixed(stats.heuristicWorst, 2)}</div>
            <div>Heuristic expected: ${formatFixed(stats.heuristicExpected, 2)}</div>
            <div>Refined worst: ${formatFixed(stats.refinedWorst, 2)}</div>
            <div>Refined expected: ${formatFixed(stats.refinedExpected, 2)}</div>
            <div>Largest buckets: ${stats.topBucketSizes.join(", ")}</div>
          </div>
        `
              : `
          <div class="inspect-note">
            On the empty board, Check Word uses strategy_stats.csv. Otherwise it compares against the current candidate set.
          </div>
        `
        }
      </div>
    </details>
  `;
}

function renderRecommendationsContent(): string {
  const displayedRecommendations = getRenderedRecommendations();

  return `
    <div class="right-panel-content">
      <div class="best-table-wrap">
        <table class="best-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Guess</th>
              <th>Type</th>
              <th>Worst</th>
              <th>Exp</th>
              <th>Info</th>
              <th>Bucket</th>
            </tr>
          </thead>

          <tbody>
            ${
              displayedRecommendations.length > 0
                ? displayedRecommendations
                    .map(
                      (item, index) => `
                        <tr
                          class="${index === 0 ? "recommended-row" : ""}"
                          data-word-choice="${item.guess}"
                        >
                          <td>${index === 0 ? "★" : index + 1}</td>
                          <td>
                            <div class="best-word-cell">
                              <span class="best-word">${item.guess.toUpperCase()}</span>
                              ${
                                index === 0
                                  ? `<span class="recommended-badge">Recommended</span>`
                                  : ""
                              }
                            </div>
                          </td>
                          <td>${recommendationTypeLabel(item)}</td>
                          <td>${formatTurns(item.worstTurns, item.exact)}</td>
                          <td>${formatFixed(item.expectedTurns, 2)}</td>
                          <td>${formatFixed(item.entropy, 2)}</td>
                          <td>${formatIntegerLike(item.worstBucket)}</td>
                        </tr>
                      `
                    )
                    .join("")
                : `
                  <tr>
                    <td colspan="7" class="empty-cell">
                      ${state.calculating ? "Searching..." : "No useful guesses found."}
                    </td>
                  </tr>
                `
            }
          </tbody>
        </table>
      </div>

      ${state.calculating ? renderProgressBar() : ""}
      ${renderInspectorPanel()}
    </div>
  `;
}

function renderBottomActions(): string {
  return `
    <div class="bottom-actions">
      <button class="bottom-action-key reset-key" id="reset-game-button">
        Reset Game
      </button>

      <button
        class="bottom-action-key calculate-key"
        id="calculate-button"
        ${state.loading || state.calculating ? "disabled" : ""}
      >
        ${state.calculating ? "Calculating..." : "Calculate Guesses"}
      </button>
    </div>
  `;
}

function renderControlsBubble(): string {
  return `
    <div class="controls-shell">
      <button class="controls-bubble" id="controls-bubble" title="Help & Controls">
        ?
      </button>

      ${
        state.controlsOpen
          ? `
        <div class="controls-popover">
          <div class="controls-head">
            <strong>Controls</strong>
            <button class="icon-button" id="close-controls-button">×</button>
          </div>

          <div class="control-hint-grid">
            <div><span class="sample-dot present-dot"></span> Click selected tile</div>
            <div>Cycle forward</div>

            <div><span class="sample-dot absent-dot"></span> Right click selected tile</div>
            <div>Cycle backward</div>

            <div><span class="sample-dot correct-dot"></span> Scroll tile</div>
            <div>Cycle state</div>

            <div><span class="sample-dot unknown-dot"></span> Backspace/Delete</div>
            <div>Clear letter + lock</div>

            <div><span class="sample-dot unknown-dot"></span> Enter</div>
            <div>Calculate guesses</div>
          </div>

          <div class="wordle-help-note">
            <strong>Wordle colors</strong>
            <div><span class="sample-dot absent-dot"></span> Gray = letter is not in the word.</div>
            <div><span class="sample-dot present-dot"></span> Yellow = letter is in the word, but in a different spot.</div>
            <div><span class="sample-dot correct-dot"></span> Green = letter is in the correct spot.</div>
          </div>
        </div>
      `
          : ""
      }
    </div>
  `;
}

function render(): void {
  const activeRows = getActiveRows();
  const showingOpeningStats =
    activeRows.length === 0 &&
    state.hasCalculated &&
    strategyStatsRows.length > 0;

  const bestPanelLabel = showingOpeningStats ? "Opening Stats" : "Best Guesses";

  const bestPanelBadge =
    showingOpeningStats
      ? "CSV Ranked"
      : liveStrategyPreview
        ? "Tree Preview"
        : "30 Live";

  app.innerHTML = `
    <main class="app-shell">
      <h1 class="app-title">Wordle Solver</h1>

      <section class="solver-layout">
        <aside class="side-panel left-side">
          <div class="side-header">
            <h2>Remaining</h2>
            <span>${state.loading ? "—" : state.candidates.length}</span>
          </div>
          ${renderLeftPanelContent()}
        </aside>

        <section class="center-game">
          ${state.loading ? `<div class="status-line">Loading word lists...</div>` : ""}
          ${state.error ? `<div class="status-line error">${escapeHtml(state.error)}</div>` : ""}
          ${renderMessages()}
          ${renderWordleBoard()}
          ${renderKeyboard()}
          ${renderBottomActions()}
        </section>

        <aside class="side-panel right-side">
          <div class="side-header">
            <h2>${bestPanelLabel}</h2>
            <span>${bestPanelBadge}</span>
          </div>
          ${renderRecommendationsContent()}
        </aside>
      </section>

            ${renderControlsBubble()}
    </main>

    <div id="chart-tooltip" class="chart-tooltip"></div>
  `;

  attachEvents();
  void refreshLiveStrategyPreviewIfNeeded();
}

function attachChartTooltipEvents(): void {
  const tooltip = document.querySelector<HTMLDivElement>("#chart-tooltip");

  if (!tooltip) {
    return;
  }

  const hideTooltip = () => {
    tooltip.classList.remove("chart-tooltip-visible");
  };

  document.querySelectorAll<HTMLElement>("[data-chart-tooltip]").forEach((element) => {
    const moveTooltip = (event: MouseEvent) => {
      const text = element.dataset.chartTooltip;

      if (!text) {
        hideTooltip();
        return;
      }

      tooltip.textContent = text;
      tooltip.style.left = `${event.clientX + 12}px`;
      tooltip.style.top = `${event.clientY + 12}px`;
      tooltip.classList.add("chart-tooltip-visible");
    };

    element.addEventListener("mouseenter", moveTooltip);
    element.addEventListener("mousemove", moveTooltip);
    element.addEventListener("mouseleave", hideTooltip);
  });
}

function attachEvents(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-cell-row][data-cell-col]").forEach((button) => {
    const row = Number(button.dataset.cellRow);
    const col = Number(button.dataset.cellCol);

    button.addEventListener("click", (event) => {
      event.preventDefault();

      const alreadySelected =
        state.selectedRow === row && state.selectedCol === col;

      selectCell(row, col);

      const cell = getCell(row, col);

      if (alreadySelected && cell.letter) {
        cycleMark(row, col, 1);
      } else {
        render();
      }
    });

    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();

      const alreadySelected =
        state.selectedRow === row && state.selectedCol === col;

      selectCell(row, col);

      const cell = getCell(row, col);

      if (alreadySelected && cell.letter) {
        cycleMark(row, col, -1);
      } else {
        render();
      }
    });

    button.addEventListener("wheel", (event) => {
      event.preventDefault();

      selectCell(row, col);

      if (getCell(row, col).letter) {
        cycleMark(row, col, event.deltaY > 0 ? 1 : -1);
      } else {
        render();
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-left-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.leftTab;

      if (tab === "remaining" || tab === "letter_positions") {
        state.activeLeftTab = tab;
        render();
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-key]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.key;

      if (key) {
        handleVirtualKey(key);
      }
    });
  });

  document.querySelectorAll<HTMLElement>("[data-word-choice]").forEach((element) => {
    element.addEventListener("click", () => {
      const word = element.dataset.wordChoice;

      if (word) {
        setRowWord(word);
      }
    });
  });

  document
    .querySelector<HTMLInputElement>("#inspect-word-input")
    ?.addEventListener("input", (event) => {
      const target = event.target as HTMLInputElement;
      state.inspectWord = normalizeWord(target.value).replace(/[^a-z]/g, "").slice(0, 5);
    });

  document
    .querySelector<HTMLInputElement>("#inspect-word-input")
    ?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        inspectWordStats();
      }
    });

  document
    .querySelector<HTMLButtonElement>("#inspect-word-button")
    ?.addEventListener("click", inspectWordStats);

  document
    .querySelector<HTMLButtonElement>("#calculate-button")
    ?.addEventListener("click", () => {
      void calculateGuesses();
    });

  document
    .querySelector<HTMLButtonElement>("#reset-game-button")
    ?.addEventListener("click", resetGame);

  document
    .querySelector<HTMLButtonElement>("#controls-bubble")
    ?.addEventListener("click", () => {
      state.controlsOpen = !state.controlsOpen;
      render();
    });

  document
    .querySelector<HTMLButtonElement>("#close-controls-button")
    ?.addEventListener("click", () => {
      state.controlsOpen = false;
      render();
    });

  document
    .querySelector<HTMLButtonElement>("#clear-current-button")
    ?.addEventListener("click", clearSelectedRowMarks);

  document
    .querySelector<HTMLButtonElement>("#clear-all-button")
    ?.addEventListener("click", resetGame);

  document
    .querySelector<HTMLButtonElement>("#undo-button")
    ?.addEventListener("click", removeLastFilledRow);

  attachChartTooltipEvents();
}
document.addEventListener("keydown", (event) => {
  const target = event.target;

  if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement
  ) {
    return;
  }

  if (/^[a-zA-Z]$/.test(event.key)) {
    appendLetter(event.key);
    return;
  }

  if (event.key === "Backspace" || event.key === "Delete") {
    deleteLetter();
    return;
  }

  if (event.key === "Enter") {
    void calculateGuesses();
    return;
  }

  if (event.key === "ArrowLeft") {
    if (state.selectedCol > 0) {
      state.selectedCol--;
    } else if (state.selectedRow > 0) {
      state.selectedRow--;
      state.selectedCol = COLS - 1;
    }

    render();
    return;
  }

  if (event.key === "ArrowRight") {
    if (state.selectedCol < COLS - 1) {
      state.selectedCol++;
    } else if (state.selectedRow < ROWS - 1) {
      state.selectedRow++;
      state.selectedCol = 0;
    }

    render();
    return;
  }

  if (event.key === "ArrowUp") {
    state.selectedRow = Math.max(0, state.selectedRow - 1);
    render();
    return;
  }

  if (event.key === "ArrowDown") {
    state.selectedRow = Math.min(ROWS - 1, state.selectedRow + 1);
    render();
  }
});

async function init(): Promise<void> {
  render();

  try {
    const [solutions, guesses, statsRows] = await Promise.all([
      loadWords("/wordlists/valid_wordle_solutions.txt"),
      loadWords("/wordlists/valid_wordle_guesses.txt"),
      loadStrategyStatsCsv("/strategy_stats.csv"),
    ]);

    state.solutions = solutions;
    state.guesses = [...new Set([...guesses, ...solutions])].sort();
    state.candidates = [...solutions];
    state.loading = false;
    state.progressTotal = state.guesses.length + DISPLAY_GUESSES;

    solutionWordSet = new Set(solutions);
    strategyStatsRows = statsRows;
    strategyStatsByWord = buildStrategyStatsMap(statsRows);
    strategyEntries = buildStrategyEntriesFromStats(statsRows);

    render();
  } catch (error) {
    state.loading = false;
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

void init();