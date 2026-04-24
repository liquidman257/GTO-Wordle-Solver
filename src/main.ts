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
  openingBook: Recommendation[];
  grid: GridCell[][];
  selectedRow: number;
  selectedCol: number;
  controlsOpen: boolean;
  candidates: string[];
  rankedCandidates: RankedCandidate[];
  recommendations: Recommendation[];
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

const DISPLAY_GUESSES = 30;
const ROWS = 6;
const COLS = 5;

const state: AppState = {
  solutions: [],
  guesses: [],
  openingBook: [],
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
  activeLeftTab: "remaining",
};

let calculationRunId = 0;
let inspectRunId = 0;

let heuristicWorker: Worker | null = null;
let refineWorkers: Worker[] = [];
let inspectWorker: Worker | null = null;

let rootRecommendationMap = new Map<string, Recommendation>();
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

async function loadOpeningBook(): Promise<Recommendation[]> {
  try {
    const response = await fetch("/opening-book.json", { cache: "no-store" });

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as unknown;

    if (!Array.isArray(data)) {
      return [];
    }

    return data.filter((item): item is Recommendation => {
      if (!item || typeof item !== "object") return false;
      const value = item as Record<string, unknown>;

      return (
        typeof value.guess === "string" &&
        typeof value.possibleAnswer === "boolean" &&
        typeof value.exact === "boolean" &&
        typeof value.worstTurns === "number" &&
        typeof value.expectedTurns === "number" &&
        typeof value.entropy === "number" &&
        typeof value.expectedRemaining === "number" &&
        typeof value.worstBucket === "number" &&
        typeof value.singletonCount === "number" &&
        typeof value.splitCount === "number"
      );
    });
  } catch {
    return [];
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
      rootRecommendationMap.set(message.rootGuess, message.recommendation);
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
      rootRecommendationMap.set(message.rootGuess, message.recommendation);
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

function getActiveRows(): GuessRow[] {
  return state.grid
    .filter(rowIsComplete)
    .map((row) => ({
      word: rowToWord(row),
      marks: row.map((cell) => cell.mark),
    }));
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
    calculateGuesses();
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

function buildOpeningBookMessages(incompleteRows: number[]): SolverMessage[] {
  const messages: SolverMessage[] = [];

  if (incompleteRows.length > 0) {
    messages.push({
      type: "warning",
      text: `Incomplete rows are ignored until all 5 letters are filled: ${incompleteRows.join(", ")}.`,
    });
  }

  messages.push({
    type: "info",
    text: "Showing precomputed opening book for the empty board.",
  });

  return messages;
}

function calculateGuesses(): void {
  if (state.loading || state.calculating) return;

  const runId = ++calculationRunId;
  cleanupWorkers();

  const activeRows = getActiveRows();
  const incompleteRows = getIncompleteRowNumbers();

  state.candidates = filterCandidates(state.solutions, activeRows);
  state.error = "";

  if (activeRows.length === 0 && state.openingBook.length > 0) {
    state.messages = buildOpeningBookMessages(incompleteRows);
    state.recommendations = [...state.openingBook];
    state.rankedCandidates = [];
    state.hasCalculated = true;
    state.calculating = false;
    state.progressProcessed = 0;
    state.progressTotal = 0;
    state.progressLabel = "";
    render();
    return;
  }

  state.messages = buildMessages(activeRows, incompleteRows, state.candidates);
  state.rankedCandidates = [];
  state.recommendations = [];
  state.hasCalculated = true;
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
        rootRecommendationMap.set(rec.guess, rec);
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
        rootRecommendationMap.set(rec.guess, rec);
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

  if (!/^[a-z]{5}$/.test(guess)) {
    state.inspectError = "Enter a 5-letter word.";
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

                const label = key === "backspace" ? "⌫" : key.toUpperCase();

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
  const shouldOpen = state.inspectLoading || Boolean(state.inspectError) || Boolean(stats);

  return `
    <details class="inspect-panel" ${shouldOpen ? "open" : ""}>
      <summary class="inspect-summary">Check Word</summary>
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
          stats
            ? `
          <div class="inspect-stats">
            <div><strong>${stats.guess.toUpperCase()}</strong> on ${stats.candidateCount} candidates</div>
            <div>Type: ${stats.possibleAnswer ? "Answer candidate" : "Probe only"}</div>
            <div>Entropy: ${stats.entropy.toFixed(4)}</div>
            <div>Expected remaining: ${stats.expectedRemaining.toFixed(2)}</div>
            <div>Worst bucket: ${stats.worstBucket}</div>
            <div>Singletons: ${stats.singletonCount}</div>
            <div>Splits: ${stats.splitCount}</div>
            <div>Heuristic worst: ${stats.heuristicWorst.toFixed(2)}</div>
            <div>Heuristic expected: ${stats.heuristicExpected.toFixed(2)}</div>
            <div>Refined worst: ${stats.refinedWorst.toFixed(2)}</div>
            <div>Refined expected: ${stats.refinedExpected.toFixed(2)}</div>
            <div>Largest buckets: ${stats.topBucketSizes.join(", ")}</div>
          </div>
        `
            : `
          <div class="inspect-note">
            Compare any first word directly against the current candidate set.
          </div>
        `
        }
      </div>
    </details>
  `;
}

function renderRecommendationsContent(): string {
  const bestHeader =
    state.hasCalculated &&
    getActiveRows().length === 0 &&
    state.openingBook.length > 0
      ? "Opening Book"
      : "Best Guesses";

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
              state.recommendations.length > 0
                ? state.recommendations
                    .map(
                      (item, index) => `
                        <tr
                          class="${index === 0 ? "recommended-row" : ""}"
                          data-word-choice="${item.guess}"
                        >
                          <td>${index === 0 ? "★" : index + 1}</td>
                          <td class="best-word-cell">
                            <span class="best-word">${item.guess.toUpperCase()}</span>
                            ${
                              index === 0
                                ? `<span class="recommended-badge">Recommended</span>`
                                : ""
                            }
                          </td>
                          <td>${item.possibleAnswer ? "Ans" : "Probe"}</td>
                          <td>${Number.isFinite(item.worstTurns) ? item.worstTurns.toFixed(item.exact ? 0 : 1) : "—"}</td>
                          <td>${Number.isFinite(item.expectedTurns) ? item.expectedTurns.toFixed(2) : "—"}</td>
                          <td>${item.entropy.toFixed(2)}</td>
                          <td>${item.worstBucket}</td>
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
      <button class="controls-bubble" id="controls-bubble" title="Controls">
        ⚙
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

          <div class="mode-description">
            Empty-board calculations now use a precomputed opening book. Non-empty states still use the dynamic worker pipeline.
          </div>

          <div class="fixed-top-note">
            Check Word is collapsible and uses the current candidate set.
          </div>

          <div class="popover-buttons">
            <button class="secondary-button" id="clear-current-button">Clear Selected Row Marks</button>
            <button class="secondary-button" id="undo-button">Clear Last Filled Row</button>
            <button class="danger-button" id="clear-all-button">Reset Game</button>
          </div>
        </div>
      `
          : ""
      }
    </div>
  `;
}

function render(): void {
  const bestPanelLabel =
    state.hasCalculated &&
    getActiveRows().length === 0 &&
    state.openingBook.length > 0
      ? "Opening Book"
      : "Best Guesses";

  const bestPanelBadge =
    state.hasCalculated &&
    getActiveRows().length === 0 &&
    state.openingBook.length > 0
      ? "Precomputed"
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
    ?.addEventListener("click", calculateGuesses);

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
document.querySelectorAll<HTMLButtonElement>("[data-left-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    const tab = button.dataset.leftTab;

    if (tab === "remaining" || tab === "letter_positions") {
      state.activeLeftTab = tab;
      render();
    }
  });
});
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
    calculateGuesses();
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
    const [solutions, guesses, openingBook] = await Promise.all([
      loadWords("/wordlists/valid_wordle_solutions.txt"),
      loadWords("/wordlists/valid_wordle_guesses.txt"),
      loadOpeningBook(),
    ]);

    state.solutions = solutions;
    state.guesses = [...new Set([...guesses, ...solutions])].sort();
    state.openingBook = openingBook;
    state.candidates = [...solutions];
    state.loading = false;
    state.progressTotal = state.guesses.length + DISPLAY_GUESSES;

    render();
  } catch (error) {
    state.loading = false;
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

void init();