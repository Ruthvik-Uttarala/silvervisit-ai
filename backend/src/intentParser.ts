import { NavigatorActionVerb, NavigatorDestination, ParsedNavigatorIntent } from "./types";

const DESTINATION_HINTS: Array<{
  destination: NavigatorDestination;
  terms: RegExp[];
}> = [
  {
    destination: "referrals",
    terms: [/\breferral\b/i, /\breferrals\b/i, /\breferred\b/i],
  },
  {
    destination: "prescriptions",
    terms: [/\bprescription\b/i, /\bprescriptions\b/i, /\bmedication\b/i, /\bmedications\b/i, /\bpharmacy\b/i],
  },
  {
    destination: "messages",
    terms: [/\bmessages?\b/i, /\binbox\b/i, /\bthread\b/i, /\bsend (?:a )?message\b/i],
  },
  {
    destination: "notes_avs",
    terms: [
      /\bafter[- ]?visit\b/i,
      /\bafter\b.*\bvisit\b/i,
      /\bavs\b/i,
      /\bdoctor notes?\b/i,
      /\bdoctor wrote\b/i,
      /\bvisit notes?\b/i,
      /\bnotes?\b/i,
    ],
  },
  {
    destination: "reports_results",
    terms: [/\blab\b/i, /\bresults?\b/i, /\breports?\b/i, /\btest results?\b/i, /\bblood test\b/i],
  },
  {
    destination: "appointments",
    terms: [/\bappointment\b/i, /\bappointments\b/i, /\bvisit\b/i, /\bjoin\b/i, /\bwaiting room\b/i, /\becheck[- ]?in\b/i],
  },
  {
    destination: "help",
    terms: [/\bhelp\b/i, /\bsupport\b/i, /\bcaregiver\b/i, /\btroubleshoot\b/i, /\bcall clinic\b/i],
  },
];

const TEMPORAL_TERMS: Array<{ key: string; pattern: RegExp }> = [
  { key: "today", pattern: /\btoday\b/i },
  { key: "tomorrow", pattern: /\btomorrow\b/i },
  { key: "yesterday", pattern: /\byesterday\b/i },
  { key: "last_week", pattern: /\blast week\b/i },
  { key: "this_afternoon", pattern: /\bthis afternoon\b/i },
  { key: "this_morning", pattern: /\bthis morning\b/i },
  { key: "tonight", pattern: /\btonight\b/i },
  { key: "newest", pattern: /\bnewest\b/i },
  { key: "most_recent", pattern: /\bmost recent\b/i },
  { key: "last_visit", pattern: /\blast visit\b/i },
];

const STOP_WORDS = new Set([
  "help",
  "please",
  "appointment",
  "visit",
  "doctor",
  "join",
  "show",
  "open",
  "take",
  "need",
  "my",
]);

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toTitleCase(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((token) => token.charAt(0).toUpperCase() + token.slice(1).toLowerCase())
    .join(" ");
}

function cleanEntity(raw: string, maxWords = 6): string | undefined {
  const normalized = normalizeWhitespace(raw.replace(/[.,;!?]+$/g, ""));
  if (!normalized) {
    return undefined;
  }
  const words = normalized.split(" ").slice(0, maxWords);
  if (words.length === 0) {
    return undefined;
  }
  if (words.every((word) => STOP_WORDS.has(word.toLowerCase()))) {
    return undefined;
  }
  return words.join(" ");
}

function pickDestination(goal: string): NavigatorDestination {
  const scores = new Map<NavigatorDestination, number>();
  for (const entry of DESTINATION_HINTS) {
    let score = 0;
    for (const term of entry.terms) {
      if (term.test(goal)) {
        score += 1;
      }
    }
    if (score > 0) {
      scores.set(entry.destination, score);
    }
  }
  if (scores.size === 0) {
    return "unknown";
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function pickActionVerb(goal: string): NavigatorActionVerb {
  if (/\bsend (?:a )?message\b/i.test(goal) || /\bwrite (?:a )?message\b/i.test(goal)) {
    return "send_message";
  }
  if (/\bjoin\b/i.test(goal) || /\battend\b/i.test(goal) || /\benter (?:the )?call\b/i.test(goal)) {
    return "join";
  }
  if (/\bopen\b/i.test(goal) || /\btake me to\b/i.test(goal) || /\bgo to\b/i.test(goal)) {
    return "open";
  }
  if (/\bshow\b/i.test(goal) || /\bfind\b/i.test(goal) || /\bwhere\b/i.test(goal)) {
    return "show";
  }
  return "unknown";
}

function extractPatientName(goal: string): string | undefined {
  const patterns = [
    /\b(?:i am|i'm|my name is|this is)\s+([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,3}?)(?=\s+(?:my date of birth|dob|i need|please|and\b|$))/i,
    /\bpatient name(?: is|:)?\s+([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,3})\b/i,
  ];

  for (const pattern of patterns) {
    const match = goal.match(pattern);
    if (!match?.[1]) {
      continue;
    }
    const cleaned = cleanEntity(match[1], 4);
    if (cleaned) {
      return toTitleCase(cleaned);
    }
  }
  return undefined;
}

function extractDob(goal: string): string | undefined {
  const labeled = goal.match(
    /\b(?:date of birth|dob)\b\s*(?:is|=|:)?\s*([a-z0-9,\-/ ]+?)(?=(?:\b(?:and|please|help|show|open|take|join|need)\b|$))/i,
  );
  if (labeled?.[1]) {
    const cleaned = cleanEntity(labeled[1], 6);
    if (cleaned) {
      return cleaned;
    }
  }
  const numeric = goal.match(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/);
  if (numeric?.[0]) {
    return numeric[0];
  }
  const monthWord = goal.match(
    /\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{4}\b/i,
  );
  return monthWord?.[0] ? normalizeWhitespace(monthWord[0]) : undefined;
}

function extractProvider(goal: string): string | undefined {
  const withDoctor = goal.match(/\b(?:from|with|my)\s+([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,3})\s+doctor\b/i);
  if (withDoctor?.[1]) {
    const cleaned = cleanEntity(withDoctor[1], 4);
    if (cleaned) {
      return toTitleCase(cleaned);
    }
  }

  const drName = goal.match(/\bdr\.?\s*([a-z][a-z'-]*(?:\s+[a-z][a-z'-]*){0,2})\b/i);
  if (drName?.[1]) {
    return `Dr. ${toTitleCase(cleanEntity(drName[1], 3) ?? drName[1])}`;
  }
  return undefined;
}

function extractSpecialty(goal: string): string | undefined {
  const direct = goal.match(
    /\b(cardiology|primary care|geriatrics?|pulmonology|neurology|oncology|dermatology|endocrinology|orthopedics?|care coordination)\b/i,
  );
  if (direct?.[1]) {
    return toTitleCase(direct[1]);
  }
  const specialist = goal.match(/\b([a-z][a-z -]{2,30})\s+(?:doctor|specialist)\b/i);
  if (specialist?.[1]) {
    const cleaned = cleanEntity(specialist[1], 4);
    return cleaned ? toTitleCase(cleaned) : undefined;
  }
  return undefined;
}

function extractTopic(goal: string): string | undefined {
  const topicPattern = goal.match(
    /\b(?:from|about|for|regarding)\s+(?:my\s+)?([a-z][a-z -]{2,40})(?=\s+(?:appointment|visit|doctor|report|result|results|page|message|thread)\b)/i,
  );
  if (topicPattern?.[1]) {
    return normalizeWhitespace(topicPattern[1]);
  }
  const appointmentPattern = goal.match(/\b([a-z][a-z -]{2,32})\s+(?:appointment|visit)\b/i);
  if (appointmentPattern?.[1]) {
    const candidate = normalizeWhitespace(appointmentPattern[1]);
    if (!STOP_WORDS.has(candidate.toLowerCase())) {
      return candidate;
    }
  }
  return undefined;
}

function extractTemporalCues(goal: string): { temporalCues: string[]; explicitDate?: string; explicitTime?: string } {
  const temporalCues = TEMPORAL_TERMS.filter((term) => term.pattern.test(goal)).map((term) => term.key);

  const explicitTimeMatch = goal.match(/\b(?:at\s+)?(\d{1,2}(?::\d{2})?\s?(?:am|pm))\b/i);
  const explicitDateMatch =
    goal.match(/\b\d{4}-\d{2}-\d{2}\b/) ??
    goal.match(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/) ??
    goal.match(
      /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b/i,
    );

  return {
    temporalCues,
    explicitDate: explicitDateMatch?.[0] ? normalizeWhitespace(explicitDateMatch[0]) : undefined,
    explicitTime: explicitTimeMatch?.[1] ? normalizeWhitespace(explicitTimeMatch[1]) : undefined,
  };
}

export function parseNavigatorIntent(userGoal: string): ParsedNavigatorIntent {
  const rawGoal = typeof userGoal === "string" ? userGoal : "";
  const goal = normalizeWhitespace(rawGoal);
  if (!goal) {
    return {
      destination: "unknown",
      actionVerb: "unknown",
      temporalCues: [],
      rawGoal: "",
    };
  }

  const temporal = extractTemporalCues(goal);
  return {
    destination: pickDestination(goal),
    actionVerb: pickActionVerb(goal),
    patientName: extractPatientName(goal),
    dob: extractDob(goal),
    providerName: extractProvider(goal),
    specialty: extractSpecialty(goal),
    topic: extractTopic(goal),
    explicitDate: temporal.explicitDate,
    explicitTime: temporal.explicitTime,
    temporalCues: temporal.temporalCues,
    rawGoal: goal,
  };
}
