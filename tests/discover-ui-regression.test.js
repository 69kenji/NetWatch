const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8')
const sidebar = fs.readFileSync(path.join(root, 'src/components/Sidebar.tsx'), 'utf8')
const discover = fs.readFileSync(path.join(root, 'src/components/DiscoverView.tsx'), 'utf8')
const styles = fs.readFileSync(path.join(root, 'src/styles/globals.css'), 'utf8')


test('sidebar exposes Home, Discover and Settings without a Search destination', () => {
  assert.match(sidebar, /onNavigate\('home'\)/)
  assert.match(sidebar, /onNavigate\('discover'\)/)
  assert.match(sidebar, /onNavigate\('settings'\)/)
  assert.doesNotMatch(sidebar, /onNavigate\('search'\)/)
  assert.doesNotMatch(sidebar, /data-tooltip="Search"/)
})

test('Home and Discover both expose the shared search control', () => {
  assert.match(app, /className="nw-catalog-topbar nw-home-topbar"/)
  assert.match(app, /<SearchBar[\s\S]*inputRef=\{homeSearchRef\}/)
  assert.match(discover, /<SearchBar[\s\S]*inputRef=\{searchInputRef\}/)
  assert.match(app, /setSearchReturnView\(origin\)/)
  assert.match(app, /view === 'search'[\s\S]*searchReturnView/)
})

test('Discover provides media, category and genre selectors', () => {
  assert.match(discover, /<option value="movies">Movies<\/option>/)
  assert.match(discover, /<option value="tv">TV<\/option>/)
  assert.match(discover, /<option value="anime">Anime<\/option>/)
  assert.match(discover, /<option value="popular">Popular<\/option>/)
  assert.match(discover, /<option value="new">New<\/option>/)
  assert.match(discover, /<option value="featured">Featured<\/option>/)
  assert.match(discover, /<option value="top">Top<\/option>/)
})

test('Discover and search stay on backend metadata routes', () => {
  assert.match(app, /\/api\/metadata\/discover\/genres/)
  assert.match(app, /\/api\/metadata\/discover\?\$\{params\}/)
  assert.match(app, /\/api\/metadata\/search\?\$\{params\}/)
  assert.doesNotMatch(app, /api\.themoviedb\.org/)
})

test('Discover uses NetWatch card grid and restrained native selectors', () => {
  assert.match(discover, /className="nw-movie-grid"/)
  assert.match(discover, /<CatalogCard/)
  assert.match(styles, /\.nw-discover-controls/)
  assert.match(styles, /\.nw-discover-controls select/)
  assert.match(styles, /\.nw-catalog-topbar/)
})
