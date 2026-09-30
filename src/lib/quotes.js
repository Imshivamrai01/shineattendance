// One quote per day (same for everyone that day), shown on the dashboard.
const QUOTES = [
  ['The secret of getting ahead is getting started.', 'Mark Twain'],
  ['Well done is better than well said.', 'Benjamin Franklin'],
  ['Quality is not an act, it is a habit.', 'Aristotle'],
  ['Success is the sum of small efforts, repeated day in and day out.', 'Robert Collier'],
  ['Alone we can do so little; together we can do so much.', 'Helen Keller'],
  ['The best way to predict the future is to create it.', 'Peter Drucker'],
  ['Do what you can, with what you have, where you are.', 'Theodore Roosevelt'],
  ['It always seems impossible until it is done.', 'Nelson Mandela'],
  ['Discipline is the bridge between goals and accomplishment.', 'Jim Rohn'],
  ['Dream big, start small, but most of all, start.', 'Simon Sinek'],
  ['Talent wins games, but teamwork wins championships.', 'Michael Jordan'],
  ['The only way to do great work is to love what you do.', 'Steve Jobs'],
  ['Coming together is a beginning, staying together is progress, and working together is success.', 'Henry Ford'],
  ['Arise, awake, and stop not till the goal is reached.', 'Swami Vivekananda'],
  ['Punctuality is the soul of business.', 'Thomas C. Haliburton'],
  ['You don\'t have to be great to start, but you have to start to be great.', 'Zig Ziglar'],
  ['Small daily improvements are the key to staggering long-term results.', 'Robin Sharma'],
  ['Great things are done by a series of small things brought together.', 'Vincent van Gogh'],
  ['Energy and persistence conquer all things.', 'Benjamin Franklin'],
  ['Whatever you are, be a good one.', 'Abraham Lincoln'],
  ['The way to get started is to quit talking and begin doing.', 'Walt Disney'],
  ['Act as if what you do makes a difference. It does.', 'William James'],
  ['Focus on being productive instead of busy.', 'Tim Ferriss'],
  ['A goal without a plan is just a wish.', 'Antoine de Saint-Exupéry'],
  ['Opportunities don\'t happen. You create them.', 'Chris Grosser'],
  ['Your work is going to fill a large part of your life; do great work.', 'Steve Jobs'],
  ['Show up. Every day. That is most of the battle.', 'Woody Allen'],
  ['Hard work beats talent when talent doesn\'t work hard.', 'Tim Notke'],
  ['Time is what we want most, but what we use worst.', 'William Penn'],
  ['If you can dream it, you can do it.', 'Walt Disney'],
  ['What you do today can improve all your tomorrows.', 'Ralph Marston'],
];

/** `key` is a YYYY-MM-DD date string; the quote is stable for that day. */
export function quoteOfTheDay(key) {
  const day = Math.floor(new Date(`${key}T00:00:00Z`).getTime() / 86400000);
  const [text, author] = QUOTES[((day % QUOTES.length) + QUOTES.length) % QUOTES.length];
  return { text, author };
}
