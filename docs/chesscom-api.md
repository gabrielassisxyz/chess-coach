# Chess.com Published-Data API

A summary of the API the game import uses. The sources below are authoritative; this page only saves re-reading them.

- [Published-Data API announcement](https://www.chess.com/news/view/published-data-api): the full reference, with every endpoint's fields. Page dated 2026-04-22; its body says last reviewed 2022-05-10.
- [Postman collection](https://www.chess.com/postman/collection-dev.json): a request for each endpoint, ready to import.

Read on 2026-11-09.

## What it is

A read-only REST API over HTTP that answers JSON-LD. It needs no credential and has no login: "you only need a URL to obtain the data". It carries public data only, so game chat and conditional moves are excluded, and it cannot send moves or commands.

## Rules that affect a client

| topic | rule |
|---|---|
| Rate limit | Serial requests are unlimited. Parallel requests may get `429 Too Many Requests`. |
| Blocking | Abnormal activity can get a client blocked. A recognisable `User-Agent` with contact details lets them reach you first. |
| Freshness | Endpoints refresh at most once every 24 hours unless noted; some say 12. |
| Caching | Responses carry `ETag` and `Last-Modified`. `If-None-Match` or `If-Modified-Since` gets a `304` when nothing changed. |
| `404` | They know no data will ever exist at that URL, and ask clients not to request it again. |
| Language | Words in responses, such as reasons a game ended, are always English. |
| Compression | `Accept-Encoding: gzip` is supported, as is HTTP/2. |
| JSONP | A `callback` query parameter wraps the response. |
| Brand | Board palettes, piece designs, sounds and move classification glyphs are Chess.com's IP. Questions go to legal@chess.com. |

## Endpoints

All under `https://api.chess.com/pub`.

| group | path |
|---|---|
| Player | `/player/{username}` |
| | `/player/{username}/stats` |
| | `/player/{username}/clubs` |
| | `/player/{username}/tournaments` |
| | `/titled/{title}` |
| Player games | `/player/{username}/games` |
| | `/player/{username}/games/to-move` |
| | `/player/{username}/games/archives` |
| | `/player/{username}/games/{YYYY}/{MM}` |
| | `/player/{username}/games/{YYYY}/{MM}/pgn` |
| | `/player/{username}/games/live/{BASETIME}/{INCREMENT}` |
| Club | `/club/{id}` |
| | `/club/{id}/members` |
| Tournament | `/tournament/{id}` |
| | `/tournament/{id}/{round}` |
| | `/tournament/{id}/{round}/{group}` |
| Team match | `/match/{id}` |
| | `/match/{id}/{board}` |
| Country | `/country/{iso}` |
| | `/country/{iso}/players` |
| | `/country/{iso}/clubs` |
| Puzzle | `/puzzle` |

The collection also holds a request for `point-system-config` on the `api.chess-dev.com` host, which is not the public one. The live archive by time control is in the announcement and not in the collection.

## A game in a monthly archive

`GET /player/{username}/games/{YYYY}/{MM}` answers finished Live and Daily games, by the month the game ended.

| field | meaning |
|---|---|
| `white`, `black` | `username`, `result`, profile `@id`, and `rating` as it stood after the game |
| `url` | the game page |
| `pgn` | final PGN |
| `fen` | final position |
| `end_time` | when the game ended, as a Unix timestamp |
| `start_time` | Daily Chess only |
| `time_control` | PGN-style time control |
| `rules` | the variant, such as `chess960` |
| `accuracies` | `white` and `black`, only if previously calculated |
| `eco`, `tournament`, `match` | URLs, when available |

Result codes: `win`, `checkmated`, `agreed`, `repetition`, `timeout`, `resigned`, `stalemate`, `lose`, `insufficient`, `50move`, `abandoned`, `kingofthehill`, `threecheck`, `timevsinsufficient`, `bughousepartnerlose`.

## How this app uses it

Two endpoints, in `packages/server/src/import/chesscom.ts`, with a `User-Agent` naming the project. The monthly archive imports games, and a `404` there is read as a month with no games. `/player/{username}` confirms an account exists before it is saved in Connections, and a `404` there refuses the save.
