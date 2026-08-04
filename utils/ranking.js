/**
 * Ranks a list of graded attempts for one exam.
 * Rule: highest score first; ties broken by shortest duration.
 * Only one (best) attempt per student is considered for ranking -
 * their best score, and on tie, their fastest qualifying attempt.
 */
function rankAttempts(attempts) {
  const byStudent = new Map();

  attempts
    .filter((a) => a.status === 'graded' || a.status === 'submitted')
    .forEach((a) => {
      const score = parseFloat(a.score) || 0;
      const duration = parseFloat(a.durationSeconds) || Infinity;
      const existing = byStudent.get(a.studentId);
      if (!existing) {
        byStudent.set(a.studentId, { ...a, score, duration });
        return;
      }
      const better =
        score > existing.score ||
        (score === existing.score && duration < existing.duration);
      if (better) byStudent.set(a.studentId, { ...a, score, duration });
    });

  const ranked = [...byStudent.values()].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.duration - b.duration;
  });

  return ranked.map((r, i) => ({ ...r, rank: i + 1 }));
}

module.exports = { rankAttempts };
