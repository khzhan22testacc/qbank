# QBank

Offline question bank for personal study. Plain HTML/CSS/JS, no build step, no internet needed after the first load.

## Files

- `index.html`, `styles.css`, `app.js`: the app
- `sw.js`: service worker that caches everything for offline use
- `manifest.json`, `icons/`: home-screen install
- `questions.json`: bundled question bank (currently 6 sample questions)

## Try it on your computer

Service workers need a real server, so don't just double-click index.html:

    cd qbank
    python3 -m http.server 8000

Then open http://localhost:8000

## Put it on your phone (GitHub Pages, free)

1. Create a new GitHub repository and upload everything in this folder (keep the `icons` folder).
2. Repository Settings → Pages → Source: "Deploy from a branch", branch `main`, folder `/ (root)`.
3. After a minute, open `https://<username>.github.io/<repo>/` on your phone.
   - iPhone: Safari → Share → Add to Home Screen
   - Android: Chrome → menu → Add to Home screen / Install app
4. Open it once from the home screen while online. From then on it works offline.

## Keeping your questions private

GitHub Pages sites are public. Since your real questions will come from textbook content, the better approach is:

- Leave only the sample `questions.json` in the repository.
- Put your real bank files (one per textbook is fine) in iCloud Drive / Files / Google Drive.
- In the app: Settings → Add question bank files. You can pick several at once.

The files are then stored inside the app on your phone, work offline, and never go on the public site. The sample questions disappear as soon as you add your own.

## Multiple banks

- Each file is its own bank, named by its `title` (e.g. "Harrison's 22e").
- After you answer a question, the app shows which bank it came from, plus the system and topic (hidden until then so they don't give the answer away).
- With more than one bank loaded, the home screen gets a Sources filter and Performance shows accuracy per source.
- Loading a file whose `id` (or, if no id, `title`) matches a bank already on the phone replaces that bank and keeps your progress. Keep each book's `id` fixed across updates.
- Removing a bank keeps its progress; it comes back if you load the file again.

## Updating the app

- Changed `index.html`, `app.js`, `styles.css` or icons: bump `CACHE` in `sw.js` (currently `qbank-v5`, so next time `qbank-v6`), push, then open the app once while online and reopen it.
- Changed the bundled `questions.json` only: just push. The app checks for a new copy whenever it opens with a connection.

## Your progress

- Stored in IndexedDB on the phone, keyed by bank id + question id.
- Settings → Export progress saves a JSON backup (share sheet on iPhone, so you can save to Files). It includes your question feedback too.
- Deleting the home-screen app or clearing website data for the site erases progress, so export occasionally.

## Spaced repetition

- Wrong answer: due again in 1 day.
- Correct answers in a row: due in 3, 7, 14, 30, 60, then 120 days.
- The "Due" filter on the home screen pulls questions whose review date has passed.

## Question format (for the generator script later)

    {
      "id": "harrisons",                       // bank id: keep the same across updates of this book
      "title": "Harrison's 22e",               // shown as the source after each answer
      "version": "2026-10-25",
      "questions": [
        {
          "id": "ch12-q007",                   // required, unique within this file, never change it
          "system": "Cardiology",              // used for filters and stats
          "topic": "Aortic stenosis",
          "stem": "Vignette text.\n\nBlank line = new paragraph. Single \n = line break (good for labs).",
          "lead": "Which of the following is the most appropriate next step?",
          "options": [
            { "label": "A", "text": "Option text", "explanation": "Why A is right or wrong" },
            { "label": "B", "text": "...", "explanation": "..." }
          ],
          "answer": "B",                       // required, must match an option label
          "explanation": "Main teaching point.",
          "source": { "book": "Book", "chapter": 12, "page": 345 },   // or a plain string
          "tags": ["valvular"]
        }
      ]
    }

Per question, required: `id`, `stem`, `options` (2 or more), `answer`. Everything else is optional. Invalid questions are skipped and counted when the file loads. `options` can also be a plain list of strings, labelled A, B, C... automatically.

## Question feedback export (input for the generator)

After answering, each question has an optional feedback box: Incorrect question, Not clinically relevant, Too long, Other, plus a free-text note. Settings → Question feedback → Export feedback file produces:

    {
      "type": "feedback",
      "exportedAt": "2026-10-25T22:30:00.000Z",
      "feedback_types": { "incorrect": "Incorrect question", "not_relevant": "Not clinically relevant",
                          "too_long": "Too long", "other": "Other" },
      "summary": { "questions": 2, "incorrect": 1, "not_relevant": 0, "too_long": 1, "other": 0 },
      "items": [
        {
          "bank_id": "harrisons",
          "bank_title": "Harrison's 22e",
          "bank_version": "2026-10-25",
          "question_id": "ch12-q007",
          "feedback": ["too_long"],
          "feedback_labels": ["Too long"],
          "note": "Stem could lose the second paragraph",
          "feedback_at": "2026-10-25T22:14:03.000Z",
          "my_performance": { "attempts": 1, "correct": 0, "last_choice": "A", "last_correct": false },
          "question": { "system": "...", "topic": "...", "stem": "...", "lead": "...", "options": [...],
                        "answer": "B", "explanation": "...", "source": {...}, "tags": [...] }
        }
      ]
    }

- `bank_id` + `question_id` identify exactly which question to fix or replace in the source file.
- `question` is the full question as it was on the phone (null only if that bank was removed before exporting).
- `my_performance` helps separate "I got it wrong" from "the question is wrong".
- Feedback stays on the phone until you clear it, so exporting twice gives the full set both times.
