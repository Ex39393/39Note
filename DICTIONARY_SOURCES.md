# Dictionary sources

39Note's offline English dictionary is generated from **Princeton WordNet 3.1**,
distributed through the `wordnet-db` 3.1.14 npm package. The generated files retain
the Princeton WordNet licence at `public/dictionary/WORDNET-LICENSE.txt`.

- Dataset: Princeton WordNet 3.1
- Source package: `wordnet-db` 3.1.14 (MIT packaging code)
- Dataset licence: Princeton WordNet License
- Source: https://wordnet.princeton.edu/
- Licence information: https://wordnet.princeton.edu/license-and-commercial-use

The source package includes Princeton's licence text under its historic
"WordNet Release 3.0" heading; WordNet 3.1 is distributed under the same terms,
and that text is copied unchanged into the generated public assets.

The build script extracts definition text only and writes first-two-letter JSON shards.
The shards are fetched lazily using Vite's `BASE_URL`, so they work at localhost and
under the `/39Note/` GitHub Pages subpath. A selected word is never transmitted by the
local lookup. 39Note currently does not enable an online Wiktionary fallback, so no
dictionary lookup sends selected words, PDF content, document titles, Notes, or files
over the network.
