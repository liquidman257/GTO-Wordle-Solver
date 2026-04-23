import "./styles.css";

import {
  type GuessRow,
  type RankedCandidate,
  type Recommendation,
  type TileMark,
  analyzeAllGuesses,
  filterCandidates,
  loadWords,
  normalizeWord,
  rankRemainingCandidatesBySolveDepth,
  selectUsefulRecommendations,
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
  grid: GridCell[][];
  selectedRow: number;
  selectedCol: number;
  controlsOpen: boolean;
  candidates: string[];
  rankedCandidates: RankedCandidate[];
  allRankings: Recommendation[];
  recommendations: Recommendation[];
  messages: SolverMessage[];
  loading: boolean;
  calculating: boolean;
  error: string;
  hasCalculated: boolean;
};

const TOP_GUESSES = 10;
const ROWS = 6;
const COLS = 5;

const state: AppState = {
  solutions: [],
  grid: createEmptyGrid(),
  selectedRow: 0,
  selectedCol: 0,
  controlsOpen: false,
  candidates: [],
  rankedCandidates: [],
  allRankings: [],
  recommendations: [],
  messages: [],
  loading: true,
  calculating: false,
  error: "",
  hasCalculated: false,
};

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
  state.grid = createEmptyGrid();
  state.selectedRow = 0;
  state.selectedCol = 0;
  state.candidates = [...state.solutions];
  state.rankedCandidates = [];
  state.allRankings = [];
  state.recommendations = [];
  state.messages = [];
  state.hasCalculated = false;

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

function calculateGuesses(): void {
  if (state.loading || state.calculating) return;

  state.calculating = true;
  render();

  window.setTimeout(() => {
    const activeRows = getActiveRows();
    const incompleteRows = getIncompleteRowNumbers();

    state.candidates = filterCandidates(state.solutions, activeRows);
    state.allRankings = analyzeAllGuesses(state.candidates, state.solutions);
    state.recommendations = selectUsefulRecommendations(
      state.allRankings,
      state.candidates.length,
      TOP_GUESSES
    );
    state.rankedCandidates = rankRemainingCandidatesBySolveDepth(
      state.candidates,
      state.solutions,
      state.allRankings
    );
    state.messages = buildMessages(activeRows, incompleteRows, state.candidates);
    state.hasCalculated = true;
    state.calculating = false;

    render();
  }, 0);
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

function renderCandidatesList(): string {
  if (!state.hasCalculated) {
    return `<div class="empty">Press Calculate Guesses after entering your known rows.</div>`;
  }

  if (state.candidates.length === 0) {
    return `<div class="empty warning">No candidates remain.</div>`;
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

function renderRecommendationsContent(): string {
  if (!state.hasCalculated) {
    return `<div class="empty">No calculation yet.</div>`;
  }

  if (state.recommendations.length === 0) {
    return `<div class="empty">No useful guesses found.</div>`;
  }

  return `
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
          ${state.recommendations
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
                  <td>${item.worstTurns.toFixed(item.exact ? 0 : 1)}</td>
                  <td>${item.expectedTurns.toFixed(2)}</td>
                  <td>${item.entropy.toFixed(2)}</td>
                  <td>${item.worstBucket}</td>
                </tr>
              `
            )
            .join("")}
        </tbody>
      </table>
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
            Left panel colors now show solve depth under the current policy:
            greener words are found sooner, redder words later.
          </div>

          <div class="fixed-top-note">
            Guess pool: solution words only. Shows at most ${TOP_GUESSES} useful guesses.
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
  app.innerHTML = `
    <main class="app-shell">
      <h1 class="app-title">Wordle Solver</h1>

      <section class="solver-layout">
        <aside class="side-panel left-side">
          <div class="side-header">
            <h2>Remaining</h2>
            <span>${state.hasCalculated ? state.candidates.length : "—"}</span>
          </div>
          ${renderCandidatesList()}
        </aside>

        <section class="center-game">
          ${state.loading ? `<div class="status-line">Loading solution list...</div>` : ""}
          ${state.error ? `<div class="status-line error">${escapeHtml(state.error)}</div>` : ""}
          ${renderMessages()}
          ${renderWordleBoard()}
          ${renderKeyboard()}
          ${renderBottomActions()}
        </section>

        <aside class="side-panel right-side">
          <div class="side-header">
            <h2>Best Guesses</h2>
            <span>GTO</span>
          </div>
          ${renderRecommendationsContent()}
        </aside>
      </section>

      ${renderControlsBubble()}
    </main>
  `;

  attachEvents();
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
    const solutions = await loadWords("/wordlists/valid_wordle_solutions.txt");

    state.solutions = solutions;
    state.candidates = [...solutions];
    state.loading = false;

    render();
  } catch (error) {
    state.loading = false;
    state.error = error instanceof Error ? error.message : String(error);
    render();
  }
}

init();