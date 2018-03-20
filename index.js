const Q = require('q')
const fs = require('fs-extra')
const path = require('path')
const moment = require('moment')
const lowDb = require('lowdb')
const lowDbStorage = require('lowdb/lib/storages/file-sync')
const sleep = require('sleep-time')
const Slack = require('slack-node')
const rssParser = require('rss-parser')
const crypto = require('crypto')

const slackWebHook = process.env.LABS_SLACK_WEBHOOK_URL_DEVPARANA_BOT_LONDRINA || ''
const dbFile = path.join(__dirname, 'data/db.json')

if (!fs.existsSync(path.dirname(dbFile)) && !fs.mkdirsSync(path.dirname(dbFile))) {
  throw new Error('Error creating data dir.')
} else if (!slackWebHook) {
  throw new Error('Slack Webhook not found in enviroment variables. Aborting...')
}

const db = lowDb(dbFile, { storage: lowDbStorage })

db.defaults({ jobs: [], settings: {} }).write()

// --------------------------------------------------------------------------ntand-----------------------

let slack = new Slack()
let deferred = Q.defer()
let deferredProcessing = Q.defer()
let deferredFinal = Q.defer()
let file4Tests = path.join(__dirname, 'jobs.rss')
let sandBox = false

let feedUrl = 'http://jobslondrina.com/job-category/programador/feed/?emprego=show&estagio=show&freelance=show&temporario=show&action=Filter&location=Londrina'
let feedRSSOptions = { customFields: {
  item: [
    [ 'job_listing:job_type', 'job_type' ],
    [ 'job_listing:company', 'company' ],
    [ 'job_listing:location', 'location' ]
  ]
}}

slack.setWebhook(slackWebHook)

_log('Searching for new job offers...')

try {
  if (sandBox && fs.existsSync(file4Tests)) {
    deferred.resolve(fs.readFileSync(file4Tests))
  } else {
    rssParser.parseURL(feedUrl, feedRSSOptions, (err, result) => {
      if (err) {
        deferred.reject(err)
        return false
      } else if (!result.feed.entries || !result.feed.entries.length) {
        deferred.reject(new Error('No Job entries were found.'))
        return false
      }

      deferred.resolve(result.feed.entries)
    })
  }

  Q.when(deferred.promise, jobs => {
    const jobsOffers = jobs.map(item => {
      const id = crypto.createHash('sha1').update(item.link).digest('hex')
      const title = item.title
      const url = item.link
      const description = item.contentSnippet
      const date = moment(item.pubDate).unix().toString()
      const dateProcessed = moment().unix()
      const botProcessed = false
      const botProcessedDate = null
      const company = ''

      return { id, title, date, company, dateProcessed, description, url, botProcessed, botProcessedDate }
    })

    deferredProcessing.resolve(jobsOffers)
  }, err => {
    _log('ERROR: ', err)
    throw err
  })

  Q.when(deferredProcessing.promise).then(jobs => {
    const jobsBaseID = db.get('jobs').value().map(item => item.id)

    jobs.filter(item => {
      return jobsBaseID.indexOf(item.id) < 0
    }).forEach(job => {
      db.get('jobs').push(job).write()
    })

    deferredFinal.resolve()
  })

  Q.when(deferredFinal.promise).then(() => {
    const jobs = Array.from(db.get('jobs').filter({ botProcessed: false }).sortBy('date').reverse().value())

    _log(`Found ${jobs.length} job offers.`)

    if (jobs.length) {
      _log('Processing items to send to slack...')
    } else {
      _log('No new jobs to send to slack...')
    }

    _log('-'.repeat(100))

    try {
      const mainTitle = (jobs.length > 1 ? 'Vagas de trabalho encontradas' : 'Vaga de trabalho encontrada') + ' em *Londrina*. Confira!'
      const slackQueue = jobs.map((item, index) => {
        return () => new Promise((resolve, reject) => {
          _log('Processing item ' + (index + 1))

          let date = moment.unix(item.date).format('DD/MM/YYYY')

          _log(item.title, date)
          _log('-'.repeat(100))

          let params = {
            text: (index === 0 ? mainTitle + '\n\n\n' : '') +
              `*${item.title}* - ${item.url}`
          }

          slack.webhook(params, (err, response) => {
            if (err) {
              return reject(err)
            }
            if (response.statusCode === 200) {
              _log('Done posting item ' + (index + 1))
              _log('-'.repeat(100))
              db.get('jobs').find({ id: item.id }).assign({ botProcessed: true, botProcessedDate: moment().unix() }).write()

              sleep(1000)
              resolve(index)
            } else {
              reject(new Error('Error processing item ' + (index + 1) + ': ' + response.statusCode + ': ' + response.statusMessage))
            }
          })
        })
      })

      Array.from(Array(slackQueue.length).keys()).reduce((promise, next) => {
        return promise.then(() => slackQueue[next]()).catch(err => { throw err })
      }, Promise.resolve())
    } catch (err) {
      _log('ERROR: ', err)
      _log('-'.repeat(100))
    }
  })
} catch (err) {
  _log('ERROR: ', err)
  _log('-'.repeat(100))
}

function _log () {
  console.log.apply(console, [].concat([`[${moment().format('DD/MM/YYYY HH:mm:ss')}] =>`], Array.from(arguments) || []))
}
