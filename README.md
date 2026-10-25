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
- Put your real bank file in iCloud Drive / Files / Google Drive.
- In the app: Settings → Load question bank file.

The file is then stored inside the app on your phone, works offline, and never goes on the public site. Loading an updated version later keeps your progress, as long as question IDs stay the same.

## Updating the app

- Changed `index.html`, `app.js`, `styles.css` or icons: bump `CACHE` in `sw.js` (e.g. `qbank-v2`), push, then open the app once while online and reopen it.
- Changed the bundled `questions.json` only: just push. The app checks for a new copy whenever it opens with a connection.

## Your progress

- Stored in IndexedDB on the phone, keyed by question ID.
- Settings → Export progress saves a JSON backup (share sheet on iPhone, so you can save to Files).
- Deleting the home-screen app or clearing website data for the site erases progress, so export occasionally.

## Spaced repetition

- Wrong answer: due again in 1 day.
- Correct answers in a row: due in 3, 7, 14, 30, 60, then 120 days.
- The "Due" filter on the home screen pulls questions whose review date has passed.

## Question format (for the generator script later)

    {
      "title": "IM QBank",
      "version": "2026-10-25",
      "questions": [
        {
          "id": "harrison-ch12-q007",          // required, unique, never change it
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

Required: `id`, `stem`, `options` (2 or more), `answer`. Everything else is optional. Invalid questions are skipped and counted when the file loads. `options` can also be a plain list of strings, labelled A, B, C... automatically.
