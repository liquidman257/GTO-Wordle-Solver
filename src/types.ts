export type FeedbackColor = "B" | "Y" | "G";
export type FeedbackPattern =
  `${FeedbackColor}${FeedbackColor}${FeedbackColor}${FeedbackColor}${FeedbackColor}`;

export type StrategyEntry = {
  name: string;
  file: string;
  sizeBytes: number;
  updatedAt: string;
};

export type StrategyNode = {
  w: string;
  d: number;
  c: Record<string, StrategyChild>;
};

export type StrategyChild =
  | {
      term: true;
      turn: number;
    }
  | {
      to: string;
      turn: number;
    };

export type StrategyTree = {
  rootId: string;
  nodes: Record<string, StrategyNode>;
};

export type GuessStep = {
  nodeId: string;
  locks: Array<FeedbackColor | null>;
  pattern: string | null;
  result: null | {
    error?: boolean;
    terminal?: boolean;
    nextNodeId?: string;
    turn?: number;
    text?: string;
  };
};

export type AppState = {
  steps: GuessStep[];
  message: string;
};

export type StrategyStatsRow = {
  starting_word: string;
  file: string;
  solutions_found: number;
  minimum_guesses: number;
  maximum_guesses: number;
  expected_guesses: number;
  total_guesses: number;
  first_guess_solves?: number;
  solved_in_1?: number;
  solved_in_2?: number;
  solved_in_3?: number;
  solved_in_4?: number;
  solved_in_5?: number;
  solved_in_6?: number;
  solved_in_7_plus?: number;
  [key: string]: string | number | undefined;
};

export type StrategyRowInput = {
  word: string;
  pattern: string | null;
};

export type StrategyBranchPreview = {
  pattern: string;
  nextWord: string | null;
  turn: number;
  terminal: boolean;
};

export type StrategyWalkResult = {
  source: "tree" | "none";
  rootWord: string | null;
  matchedDepth: number;
  nextWord: string | null;
  terminal: boolean;
  error: string | null;
  branchOptions: StrategyBranchPreview[];
  stats: StrategyStatsRow | null;
};

export type StrategyTreeCache = Map<string, Promise<StrategyTree | null> | StrategyTree | null>;
