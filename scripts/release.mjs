import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const CHANGELOG_UNRELEASED_TEMPLATE = [
  '## [Unreleased]',
  '',
  '### Added',
  '',
  '### Changed',
  '',
  '### Fixed',
  '',
  '### Removed',
  '',
  '### Security',
  '',
].join('\n')

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)$/

function usage() {
  return [
    'Uso:',
    '  npm run release -- patch',
    '  npm run release -- minor',
    '  npm run release -- major',
    '  npm run release -- 1.2.3',
    'Opciones:',
    '  --dry-run   Muestra cambios sin escribir archivos.',
  ].join('\n')
}

function incrementVersion(currentVersion, releaseType) {
  const match = currentVersion.match(SEMVER_RE)

  if (!match) {
    throw new Error(`La versión actual no es SemVer válida: ${currentVersion}`)
  }

  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])

  switch (releaseType) {
    case 'major':
      return `${major + 1}.0.0`
    case 'minor':
      return `${major}.${minor + 1}.0`
    case 'patch':
      return `${major}.${minor}.${patch + 1}`
    default:
      throw new Error(`Tipo de release no soportado: ${releaseType}`)
  }
}

function ensureSemver(version) {
  if (!SEMVER_RE.test(version)) {
    throw new Error(`Versión inválida: ${version}. Esperado: x.y.z`)
  }
}

function getToday() {
  return new Date().toISOString().slice(0, 10)
}

function updateChangelog(content, nextVersion, date) {
  const unreleasedRegex = /^## \[Unreleased\]\s*\n([\s\S]*?)(?=^## \[|\Z)/m
  const match = content.match(unreleasedRegex)

  if (!match) {
    throw new Error('No encontré la sección "## [Unreleased]" en CHANGELOG.md')
  }

  const unreleasedBody = match[1].trimEnd()
  const releaseSectionHeader = `## [${nextVersion}] - ${date}`
  const releaseSection = unreleasedBody
    ? `${releaseSectionHeader}\n\n${unreleasedBody}`
    : `${releaseSectionHeader}\n`

  return content.replace(
    unreleasedRegex,
    `${CHANGELOG_UNRELEASED_TEMPLATE}\n\n${releaseSection}\n\n`,
  )
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const target = args.find((arg) => arg !== '--dry-run')

  if (!target || target === '--help' || target === '-h') {
    console.log(usage())
    process.exit(target ? 0 : 1)
  }

  const packageJsonPath = resolve(process.cwd(), 'package.json')
  const packageLockPath = resolve(process.cwd(), 'package-lock.json')
  const changelogPath = resolve(process.cwd(), 'CHANGELOG.md')

  const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  const packageLock = JSON.parse(await readFile(packageLockPath, 'utf8'))
  const changelog = await readFile(changelogPath, 'utf8')

  const currentVersion = packageJson.version
  const nextVersion =
    target === 'patch' || target === 'minor' || target === 'major'
      ? incrementVersion(currentVersion, target)
      : target

  ensureSemver(nextVersion)

  if (currentVersion === nextVersion) {
    throw new Error(`La versión destino es igual a la actual (${currentVersion}).`)
  }

  const date = getToday()
  const updatedChangelog = updateChangelog(changelog, nextVersion, date)

  packageJson.version = nextVersion
  packageLock.version = nextVersion
  if (packageLock.packages?.['']) {
    packageLock.packages[''].version = nextVersion
  }

  if (dryRun) {
    console.log(`[dry-run] versión actual: ${currentVersion}`)
    console.log(`[dry-run] versión nueva:  ${nextVersion}`)
    console.log(`[dry-run] fecha release:  ${date}`)
    console.log('[dry-run] No se escribieron archivos.')
    return
  }

  await writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`)
  await writeFile(packageLockPath, `${JSON.stringify(packageLock, null, 2)}\n`)
  await writeFile(changelogPath, updatedChangelog)

  console.log(`Release preparado: v${nextVersion}`)
  console.log('Archivos actualizados:')
  console.log('- package.json')
  console.log('- package-lock.json')
  console.log('- CHANGELOG.md')
  console.log('')
  console.log('Siguiente paso sugerido:')
  console.log(`git add package.json package-lock.json CHANGELOG.md && git commit -m "chore(release): v${nextVersion}" && git tag v${nextVersion}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
