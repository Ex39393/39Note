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
under the `/39Note/` GitHub Pages subpath. WordNet is always queried first and remains
available offline. A WordNet lookup never transmits the selected word.

## English Wiktionary enrichment

When the user explicitly presses **Look up word**, 39Note may request the experimental
structured definition endpoint provided by English Wiktionary:

- Endpoint: `https://en.wiktionary.org/api/rest_v1/page/definition/{word}`
- Data used: English definition text and part of speech only
- Data excluded: quotations, examples, citations, etymology, pronunciation,
  translations, images, audio, related-word lists, and page markup
- Licence: CC BY-SA 4.0 and GFDL
- Attribution: English Wiktionary contributors

The provider is isolated behind a replaceable adapter because Wikimedia documents the
structured definition endpoint as experimental. Returned markup is converted to plain
text and rendered as untrusted React text; it is never inserted as HTML.

## NLM MeSH enrichment

39Note uses the official NCBI E-utilities MeSH database for conservative exact-term
enrichment. A result is accepted only when the selected single word exactly matches a
MeSH heading or entry term and the record has a non-empty Scope Note.

- API: NCBI E-utilities `esearch` and `esummary`, database `mesh`
- Version recorded by this adapter: MeSH 2026
- Data used: preferred heading, exact term relationship, Scope Note, and MeSH unique ID
- Terms: https://www.nlm.nih.gov/databases/download/terms_and_conditions_mesh.html
- Acknowledgement: Courtesy of the U.S. National Library of Medicine

NLM does not endorse 39Note. MeSH is supplemental specialist terminology and is not
used as a general-purpose replacement for WordNet or Wiktionary.

## Privacy and caching

Online requests contain only the normalized single selected word. 39Note never sends
the surrounding PDF passage, PDF title or filename, document ID, annotations, Notes,
Glossary contents, or user identity to a dictionary provider.

Successful remote definitions are cached in the separate
`39note-dictionary-cache` IndexedDB database. Wiktionary entries expire after 30 days;
MeSH entries are version-aware and expire after one year. Failures and malformed
responses are not cached. This cache is excluded from Library Backup and Package
Selected archives and can be removed with **Clear Dictionary Cache** in Dictionary
sources. Glossary entries remain ordinary backed-up user data and retain the source
metadata for the chosen definition.
