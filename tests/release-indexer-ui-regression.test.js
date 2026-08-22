const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const movie = fs.readFileSync(path.join(root, 'src/components/MovieDetailsView.tsx'), 'utf8')
const series = fs.readFileSync(path.join(root, 'src/components/SeriesDetailsView.tsx'), 'utf8')

test('release rows append the originating Prowlarr indexer to metadata', () => {
  const metadata = /\[result\.resolution, result\.source, result\.codec, result\.audio, result\.indexer\]/
  assert.match(movie, metadata)
  assert.match(series, metadata)
})
