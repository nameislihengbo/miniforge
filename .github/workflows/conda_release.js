const https = require('https')

const options = {
  hostname: 'api.anaconda.org',
  port: 443,
  path: '/package/conda-forge/conda',
  method: 'GET',
  timeout: 15000
}

function compareVersions(version1, version2) {
  const ver1 = String(version1).split('.').map(Number)
  const ver2 = String(version2).split('.').map(Number)

  const common_length = Math.min(ver1.length, ver2.length)
  for (let i = 0; i < common_length; ++i) {
    if (ver1[i] < ver2[i]) return -1
    if (ver1[i] > ver2[i]) return 1
  }

  if (ver1.length > common_length) return 1
  if (ver2.length > common_length) return -1
  return 0
}

function fetchCondaVersion() {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        reject(new Error('upstream returned HTTP ' + res.statusCode))
        return
      }
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          const body = JSON.parse(data)
          const versions = body.files.map((x) => x.version).filter(Boolean)
          versions.sort(compareVersions)
          resolve(versions.pop())
        } catch (e) {
          reject(new Error('invalid JSON from upstream: ' + e.message))
        }
      })
    })
    req.on('timeout', () => req.destroy(new Error('request timed out')))
    req.on('error', (err) => reject(new Error('upstream network error: ' + err.message)))
    req.end()
  })
}

async function withRetry(fn, retries = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      if (attempt > retries) throw err
      const delay = 1000 * attempt
      console.warn(`[retry ${attempt}/${retries}] conda release check failed: ${err.message}; retrying in ${delay}ms`)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
}

module.exports = async ({ github, context }) => {
  try {
    const conda_version = await withRetry(fetchCondaVersion)
    const release = await github.rest.repos.getLatestRelease({
      owner: context.repo.owner,
      repo: context.repo.repo,
    })
    const current_version = release.data.tag_name.split('-')[0]
    console.log(`upstream conda=${conda_version} local=${current_version}`)

    if (compareVersions(conda_version, current_version) !== 1) {
      console.log('no newer conda release; nothing to do')
      return
    }

    const { data: issues } = await github.rest.issues.listForRepo({
      owner: context.repo.owner,
      repo: context.repo.repo,
      state: 'open',
      labels: '[bot] conda release',
    })
    if (issues.length > 0) {
      console.log('an open issue already exists; skip')
      return
    }

    await github.rest.issues.create({
      owner: context.repo.owner,
      repo: context.repo.repo,
      title: 'New conda release: please tag a miniforge release',
      body: 'A new conda release was found, please tag a new miniforge release with `' + conda_version + '-0`',
      labels: ['[bot] conda release'],
    })
    console.log('opened issue for conda ' + conda_version)
  } catch (err) {
    // Non-critical watcher that reruns every 6h. On persistent failure, log a
    // warning instead of failing the job, so transient upstream flakiness no
    // longer marks the workflow red.
    console.warn('WARN: failed to check conda release (will retry on next schedule): ' + err.message)
  }
}