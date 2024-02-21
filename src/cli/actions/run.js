const fs = require('fs')
const execa = require('execa')
const logger = require('./../../shared/logger')
const helpers = require('./../helpers')
const main = require('./../../lib/main')
const parseEncryptionKeyFromDotenvKey = require('./../../lib/helpers/parseEncryptionKeyFromDotenvKey')

const ENCODING = 'utf8'
const REPORT_ISSUE_LINK = 'https://github.com/dotenvx/dotenvx/issues/new'

const executeCommand = async function (commandArgs, env) {
  const signals = [
    'SIGHUP', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT',
    'SIGBUS', 'SIGFPE', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGTERM'
  ]

  logger.debug(`executing process command [${commandArgs.join(' ')}]`)

  // handler for SIGINT
  let commandProcess
  const sigintHandler = () => {
    logger.debug('received SIGINT')
    logger.debug('checking command process')
    logger.debug(commandProcess)

    if (commandProcess) {
      logger.debug('sending SIGINT to command process')
      commandProcess.kill('SIGINT') // Send SIGINT to the command process
    } else {
      logger.debug('no command process to send SIGINT to')
    }
  }

  const handleOtherSignal = (signal) => {
    logger.debug(`received ${signal}`)
  }

  try {
    commandProcess = execa(commandArgs[0], commandArgs.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, ...env }
    })

    process.on('SIGINT', sigintHandler)

    signals.forEach(signal => {
      process.on(signal, () => handleOtherSignal(signal))
    })

    // Wait for the command process to finish
    const { exitCode } = await commandProcess

    if (exitCode !== 0) {
      logger.debug(`received exitCode ${exitCode}`)
      throw new Error(`Command failed with exit code ${exitCode}`)
    }
  } catch (error) {
    if (error.signal !== 'SIGINT') {
      logger.error(error.message)
      logger.error(`command [${commandArgs.join(' ')}] failed`)
      logger.error('')
      logger.error(`  try without dotenvx: [${commandArgs.join(' ')}]`)
      logger.error('')
      logger.error('if that succeeds, then dotenvx is the culprit. report issue:')
      logger.error(`<${REPORT_ISSUE_LINK}>`)
    }

    // Exit with the error code from the command process, or 1 if unavailable
    process.exit(error.exitCode || 1)
  } finally {
    // Clean up: Remove the SIGINT handler
    process.removeListener('SIGINT', sigintHandler)
  }
}

const _parseCipherTextFromDotenvKeyAndParsedVault = function (dotenvKey, parsedVault) {
  // Parse DOTENV_KEY. Format is a URI
  let uri
  try {
    uri = new URL(dotenvKey)
  } catch (e) {
    throw new Error(`INVALID_DOTENV_KEY: ${e.message}`)
  }

  // Get environment
  const environment = uri.searchParams.get('environment')
  if (!environment) {
    throw new Error('INVALID_DOTENV_KEY: Missing environment part')
  }

  // Get ciphertext payload
  const environmentKey = `DOTENV_VAULT_${environment.toUpperCase()}`
  const ciphertext = parsedVault[environmentKey] // DOTENV_VAULT_PRODUCTION
  if (!ciphertext) {
    throw new Error(`NOT_FOUND_DOTENV_ENVIRONMENT: cannot locate environment ${environmentKey} in your .env.vault file`)
  }

  return ciphertext
}

async function run () {
  const commandArgs = this.args
  logger.debug(`process command [${commandArgs.join(' ')}]`)

  const options = this.opts()
  logger.debug(`options: ${JSON.stringify(options)}`)

  // load from .env.vault file
  if (process.env.DOTENV_KEY && process.env.DOTENV_KEY.length > 0) {
    const envVaultFilepath = options.envVaultFile // .env.vault
    const filepath = helpers.resolvePath(envVaultFilepath)

    if (!fs.existsSync(filepath)) {
      logger.error(`you set DOTENV_KEY but your .env.vault file is missing: ${filepath}`)
    } else {
      logger.verbose(`loading env from encrypted ${filepath}`)

      try {
        const src = fs.readFileSync(filepath, { encoding: ENCODING })
        const parsedVault = main.parse(src)

        logger.debug(`decrypting encrypted env from ${filepath}`)
        // handle scenario for comma separated keys - for use with key rotation
        // example: DOTENV_KEY="dotenv://:key_1234@dotenvx.com/vault/.env.vault?environment=prod,dotenv://:key_7890@dotenvx.com/vault/.env.vault?environment=prod"
        const dotenvKeys = process.env.DOTENV_KEY.split(',')
        const length = dotenvKeys.length

        let decrypted
        for (let i = 0; i < length; i++) {
          try {
            // Get full dotenvKey
            const dotenvKey = dotenvKeys[i].trim()

            const key = parseEncryptionKeyFromDotenvKey(dotenvKey)
            const ciphertext = _parseCipherTextFromDotenvKeyAndParsedVault(dotenvKey, parsedVault)

            // Decrypt
            decrypted = main.decrypt(ciphertext, key)

            break
          } catch (error) {
            // last key
            if (i + 1 >= length) {
              throw error
            }
            // try next key
          }
        }
        logger.debug(decrypted)
        const parsed = main.parseExpand(decrypted)
        const result = main.inject(process.env, parsed, options.overload)

        logger.successv(`injecting env (${result.injected.size}) from encrypted ${envVaultFilepath}`)
      } catch (e) {
        logger.error(e)
      }
    }
  } else {
    // convert to array if needed
    let optionEnvFile = options.envFile
    if (!Array.isArray(optionEnvFile)) {
      optionEnvFile = [optionEnvFile]
    }

    const readableFilepaths = new Set()
    const injected = new Set()

    for (const envFilepath of optionEnvFile) {
      const filepath = helpers.resolvePath(envFilepath)

      logger.verbose(`loading env from ${filepath}`)

      try {
        const src = fs.readFileSync(filepath, { encoding: ENCODING })
        const parsed = main.parseExpand(src, options.overload)
        const result = main.inject(process.env, parsed, options.overload)

        readableFilepaths.add(envFilepath)
        result.injected.forEach(key => injected.add(key))
      } catch (e) {
        // calculate development help message depending on state of repo
        const vaultFilepath = helpers.resolvePath('.env.vault')
        let developmentHelp = `? in development: add one with [echo "HELLO=World" > .env] and re-run [dotenvx run -- ${commandArgs.join(' ')}]`
        if (fs.existsSync(vaultFilepath)) {
          developmentHelp = `? in development: use [dotenvx decrypt] to decrypt .env.vault to .env and then re-run [dotenvx run -- ${commandArgs.join(' ')}]`
        }

        switch (e.code) {
          // missing .env
          case 'ENOENT':
            logger.warnv(`missing ${envFilepath} file (${filepath})`)
            logger.help(developmentHelp)
            logger.help('? for production: set [DOTENV_KEY] on your server and re-deploy')
            logger.help('? for ci: set [DOTENV_KEY] on your ci and re-build')
            break

          // unhandled error
          default:
            logger.warn(e)
            break
        }
      }
    }

    if (readableFilepaths.size > 0) {
      logger.successv(`injecting env (${injected.size}) from ${[...readableFilepaths]}`)
    }
  }

  // Extract command and arguments after '--'
  const commandIndex = process.argv.indexOf('--')
  if (commandIndex === -1 || commandIndex === process.argv.length - 1) {
    logger.error('missing command after [dotenvx run --]')
    logger.error('')
    logger.error('  get help: [dotenvx help run]')
    logger.error('  or try:   [dotenvx run -- npm run dev]')
    process.exit(1)
  } else {
    // const commandArgs = process.argv.slice(commandIndex + 1)
    await executeCommand(commandArgs, process.env)
  }
}

module.exports = run
