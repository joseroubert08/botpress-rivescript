import path from 'path'
import fs from 'fs-extra'
import _ from 'lodash'

import RiveScript from 'rivescript'

import calls from './calls'
import deliveries from './deliveries'

var rs = null

const validateRiveName = (name) => /[A-Z0-9_-]+/i.test(name)

const incomingMiddleware = (event, next) => {
  if (event.platform === 'facebook') {

    if (event.type !== 'message') {
      return next()
    }

    rs.setUservar(event.user.id, 'platform', event.platform)
    rs.setUservars(event.user.id, event.user)
    rs.replyAsync(event.user.id, event.text)
    .then(reply => {
      deliveries.forEach(delivery => {
        if(delivery && delivery.test.test(reply)) {
          delivery.handler(delivery.test.exec(reply), rs, event.bp, event)
          next()
          return
        }
      })
      event.bp.messenger.sendText(event.user.id, reply)
    })
  } else {
    throw new Error('Unsupported platform: ', event.platform)
  }
  next()
}

module.exports = {
  init: function(bp) {
    bp.middlewares.register({
      name: 'rivescript.processIncomingMessages',
      order: 10,
      type: 'incoming',
      module: 'botpress-rivescript',
      handler: incomingMiddleware,
      description: 'Processes incoming messages by the RiveScript engine and sends responses'
    })
  },
  ready: function(bp) {

    const riveDirectory = path.join(bp.dataLocation, 'rivescript')
    const memoryFile = path.join(bp.dataLocation, 'rivescript.brain.json')

    if (!fs.existsSync(riveDirectory)) {
      fs.mkdirSync(riveDirectory)
      fs.copySync(path.join(__dirname, '../templates'), riveDirectory)
    }

    const saveMemory = () => {
      if (rs && rs.write) {
        const usersVars = {}
        const users = _.keys(rs._users)
        users.forEach(user => {
          usersVars[user] = rs.getUservars(user)
        })

        const content = JSON.stringify(usersVars)
        fs.writeFileSync(memoryFile, content)
      }
    }
    const restoreMemory = () => {
      if (fs.existsSync(memoryFile)) {
        bp.logger.debug('[rivescript] Restoring brain')
        const content = JSON.parse(fs.readFileSync(memoryFile))
        const users = _.keys(content)
        users.forEach(user => rs.setUservars(user, content[user]))
      }
    }

    const reloadRiveScript = () => {
      saveMemory()

      rs = new RiveScript()

      rs.loadDirectory(riveDirectory, (batchNumber) => {
        rs.sortReplies()
        restoreMemory()
      }, (err) => {
        console.log('Error', err) // TODO clean that
      })

      calls(rs)
    }

    reloadRiveScript()


    setInterval(saveMemory, 30000)
    const router = bp.getRouter('botpress-rivescript')


    router.get('/scripts', (req, res, next) => {
      const data = {}
      const files = fs.readdirSync(riveDirectory)
      for (let file of files) {
        const name = file.replace(/\.rive$/, '')
        const content = fs.readFileSync(path.join(riveDirectory, file)).toString()
        data[name] = content
      }
      res.send(data)
    })

    router.delete('/scripts/:name', (req, res, next) => {
      const { name } = req.params

      if (!name || name.length <= 0 || !validateRiveName(name)) {
        throw new Error('Invalid rivescript name: ' + name)
      }

      const filePath = path.join(riveDirectory, name + '.rive')

      if (!fs.existsSync(filePath)) {
        throw new Error("This script doesn't exist")
      }

      fs.unlinkSync(filePath)

      reloadRiveScript()

      res.sendStatus(200)
    })

    // create a new script
    router.post('/scripts', (req, res, next) => {
      const { name, content, overwrite } = req.body

      if (!name || name.length <= 0 || !validateRiveName(name)) {
        throw new Error('Invalid rivescript name: ' + name)
      }

      const filePath = path.join(riveDirectory, name + '.rive')

      if (!overwrite && fs.existsSync(filePath)) {
        throw new Error("Can't overwrite script: " + name)
      }

      fs.writeFileSync(filePath, content)

      reloadRiveScript()

      res.sendStatus(200)
    })

    router.post('/reset', (req, res, next) => {
      reloadRiveScript()
      res.sendStatus(200)
    })

    router.post('/simulate', (req, res, next) => {
      const { text } = req.body
      rs.replyAsync('local-user', text)
      .then((reply) => {
        deliveries.forEach(delivery => {
          if(delivery && delivery.test.test(reply)) {
            res.send('[Would be delivered by "' + delivery.name + '"]: ' + reply)
            return
          }
        })
        res.send(reply)
      })
    })

  }
}
