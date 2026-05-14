const express = require("express");
const path = require("path");
const bodyParser = require("body-parser");
const session = require("express-session");
const bcrypt = require("bcrypt");
const config = require("./config.js");
const movieModel = require("./movie-model.js");
const userModel = require("./user-model.js");

const app = express();

// Parse urlencoded bodies
app.use(bodyParser.json());

// Session middleware
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, 
    sameSite: 'lax',
    maxAge: 1000*60*60
  }
}));

app.use((req, res, next) => {
  console.log(req.method, 'sid:', req.sessionID, 'user:', req.session?.user?.username);
  next();
})

//Helpers for movie normalization
function toISODate(v) {
  if (!v || v === 'N/A') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function toMinutes(v) {
  if (!v || v === 'N/A') return null;
  const n = parseInt(v, 10); // handles "123 min"
  return Number.isNaN(n) ? null : n;
}

function toList(v) {
  return v && v !== 'N/A'
    ? v.split(',').map(s => s.trim()).filter(Boolean)
    : [];
}

function cleanStr(v) {
  return v && v !== 'N/A' ? v : null;
}

function toFloat(v) {
  if (!v || v === 'N/A') return null;
  const n = parseFloat(v);
  return Number.isNaN(n) ? null : n;
}

//only logged in users can hit protected endpoints
function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  res.sendStatus(401);
}

// Serve static content in directory 'files'
app.use(express.static(path.join(__dirname, "files")));

app.post("/login", function (req, res) {
  const { username, password } = req.body;
  const user = userModel[username];

  if (user && bcrypt.compareSync(password, user.password)) {
    req.session.user = {
      username,
      firstName: user.firstName,
      lastName: user.lastName,
      loginTime: new Date().toISOString(),
    };
    req.session.save(err => {
      if (err) {
        console.error("Session save failed", err);
        return res.sendStatus(500);
      }
      res.send(req.session.user);
    });
  } else {
    res.sendStatus(401);
  }
});

// Task 1.3: Implement the GET `/logout` endpoint and requireLogin
// protection. Implement logout by destroying the session 
// with error handling. Protect all endpoints that need 
// authentication with `requireLogin`.
app.get("/logout", requireLogin, function (req, res) {
  if (!req.session) return res.sendStatus(200);
  req.session.destroy(err => {
    if (err) {
      console.error("Session destroy failed", err);
      return res.sendStatus(500);
    }
    res.clearCookie("connect.sid");
    res.sendStatus(200);
  });
});

app.get("/session", function (req, res) {
  if (req.session.user) {
    res.send(req.session.user);
  } else {
    res.status(401).json(null);
  }
});

app.get("/movies", requireLogin, function (req, res) {
  const username = req.session.user.username;
  let movies = Object.values(movieModel.getUserMovies(username));
  const queriedGenre = req.query.genre;
  if (queriedGenre) {
    movies = movies.filter((movie) => movie.Genres.indexOf(queriedGenre) >= 0);
  }
  res.send(movies);
});

// Configure a 'get' endpoint for a specific movie
app.get("/movies/:imdbID", requireLogin, function (req, res) {
  const username = req.session.user.username;
  const id = req.params.imdbID;
  const movie = movieModel.getUserMovie(username, id);

  if (movie) {
    res.send(movie);
  } else {
    res.sendStatus(404);
  }
});

// Configure a 'put' endpoint for a specific movie to update or insert a movie
app.put("/movies/:imdbID", requireLogin, function (req, res) {
  const username = req.session.user.username;
  const imdbID = req.params.imdbID;
  const exists = movieModel.getUserMovie(username, imdbID) !== undefined;

  if (!exists) {
    // Task 2.3: Fetch the movie data from OmdbAPI, follow the pattern used further down 
    // in the GET /search endpoint. Implement conversion of the OmdbAPI response to the 
    // movie format used in the frontend. Make sure to handle errors and timeouts properly.
    const url = `http://www.omdbapi.com/?i=${encodeURIComponent(imdbID)}&apikey=${config.omdbApiKey}&plot=short`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(),
      config.omdbTimeoutMs)

    fetch(url, { signal: controller.signal })
      .then(apiRes => {
        clearTimeout(timeoutId);
        if (!apiRes.ok) {
          return res.sendStatus(apiRes.status);
        }
        return apiRes.json();
      })
      .then(data => {
        if (!data) return;

        if (data.Response === 'False') {
          return res.sendStatus(404);
        }

        const movie = {
          imdbID: data.imdbID,
          Title: data.Title,
          Released: toISODate(data.Released),
          Runtime: toMinutes(data.Runtime),
          Genres: toList(data.Genre),
          Directors: toList(data.Director),
          Writers: toList(data.Writer),
          Actors: toList(data.Actors),
          Plot: cleanStr(data.Plot),
          Poster: cleanStr(data.Poster),
          Metascore: toFloat(data.Metascore),
          imdbRating: toFloat(data.imdbRating)
        };

        movieModel.setUserMovie(username, imdbID, movie);
        return res.sendStatus(201);
      })
      .catch(err => {
        clearTimeout(timeoutId);
        if (err.name === 'AbortError')
          return res.sendStatus(504);
        console.error('OMDb API error:', err);
        return res.sendStatus(500);
      });
  } else {
    res.sendStatus(200);
  }
});

app.delete("/movies/:imdbID", requireLogin, function (req, res) {
  const username = req.session.user.username;
  const id = req.params.imdbID;
  if (movieModel.deleteUserMovie(username, id)) {
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// Configure a 'get' endpoint for genres of all movies of the current user
app.get("/genres", requireLogin, function (req, res) {
  const username = req.session.user.username;
  const genres = movieModel.getGenres(username);
  genres.sort();
  res.send(genres);
});

//search
app.get("/search", requireLogin, function (req, res) {
  const username = req.session.user.username;
  const query = req.query.query;
  if (!query) {
    return res.sendStatus(400);
  }

  const url = `http://www.omdbapi.com/?s=${encodeURIComponent(query)}&apikey=${config.omdbApiKey}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.omdbTimeoutMs);

  fetch(url, { signal: controller.signal })
    .then(apiRes => {
      clearTimeout(timeoutId);
      if (!apiRes.ok) {
        return res.sendStatus(apiRes.status);
      }
      return apiRes.text().then(data => {
        let response;
        try {
          response = JSON.parse(data);
        } catch (parseError) {
          console.error('Failed to parse OMDb response:', parseError);
          return res.sendStatus(500);
        }

        if (response.Response === 'True') {
          const results = response.Search
            .filter(movie => !movieModel.hasUserMovie(username, movie.imdbID))
            .map(movie => ({
              Title: movie.Title,
              imdbID: movie.imdbID,
              Year: isNaN(movie.Year) ? null : parseInt(movie.Year)
            }));
          res.send(results);
        } else {
          res.send([]);
        }
      });
    })
    .catch((err) => {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        console.error('OMDb API request timeout');
        return res.sendStatus(504);
      }
      console.error('OMDb API error:', err);
      res.sendStatus(500);
    });
});

app.listen(config.port);

console.log(`Server now listening on http://localhost:${config.port}/`);
