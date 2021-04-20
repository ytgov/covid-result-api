// noinspection ExceptionCaughtLocallyJS

require('dotenv').config();

let knex = require('knex');
let express = require('express');
let moment = require('moment');
let app = express();
let port = process.env.PORT || 3000;

let sqlite3 = require('sqlite3');
sqlite3.verbose();
let open = require('sqlite').open;

app.use(express.json()) // for parsing application/json
app.use(express.urlencoded({extended: true})) // for parsing application/x-www-form-urlencoded

app.set("mssqlDb", knex({
  client: 'mssql',
  connection: {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    options: {
      enableArithAbort: true,
    }
  }
}));

app.set('sqliteDb', knex({
  client: 'sqlite3',
  connection: {
    filename: './database.db',
  },
  useNullAsDefault: true
}));


// Create the SQLite tables, as necessary.
(async () => {
  const sqliteDb = app.get('sqliteDb')

  try {
    await Promise.all([
      // Requests for SMS notification.
      sqliteDb.schema.hasTable('to_notify')
        .then(exists => {
          if (!exists) {
            return sqliteDb.schema.createTable('to_notify', t => {
              t.increments('id')
              t.timestamp('requestTime').defaultTo(sqliteDb.fn.now())
              t.text('preferredLanguage')
              t.text('notificationTelephone')
              t.integer('specimenId')
            })
          }
        }),
      // Delivery of Negative test results.
      sqliteDb.schema.hasTable('viewed_result')
        .then(exists => {
          if (!exists) {
            return sqliteDb.schema.createTable('viewed_result', t => {
              t.increments('id')
              t.timestamp('viewedTime').defaultTo(sqliteDb.fn.now())
              t.integer('specimenId')
            })
          }
        })
    ])
  } catch (err) {
    console.error(`Attempt to create table failed: ${err}`)
  }
})()


// Verify connection to database and existing data for necessary columns.
app.get('/status', async (req, res) => {
  const db = req.app.get('mssqlDb')

  try {
    const rows = await db.select('PatientName', 'DOB', 'CollectionDateTime', 'ResultedDateTime', 'Result', 'SpecimenID')
      .from('CovidTestResults')
      .limit(5)

    if (rows.length !== 5) {
      throw new Error('Unexpected number of test results in database.')
    }

    const msg = 'API status verified.'
    console.log(msg)
    res.status(200).send(msg)
  } catch (err) {
    const msg = `Attempt to verify API status failed: ${err}`
    console.error(msg)
    res.status(500).send(msg)
  }
})


// Retrieve a test result.
app.put('/test-result', async (req, res) => {
  /** @namespace body.lastName **/
  /** @namespace body.healthCareNumber **/
  /** @namespace body.birthDate **/
  const {body} = req

  if (!body.lastName || !body.healthCareNumber || !body.birthDate) {
    res.status(400).send("Bad request")
    return
  }

  const healthCareNumber = body.healthCareNumber.replace(/-/g, '')
  const dob = body.birthDate.replace(/-/g, '')
  const lastName = body.lastName.toUpperCase()
  const mssqlDb = req.app.get('mssqlDb')

  try {
    const rows = await mssqlDb.select('PatientName', 'DOB', 'CollectionDateTime', 'ResultedDateTime', 'Result', 'SpecimenID')
      .from('CovidTestResults')
      .where('HCN', healthCareNumber)
      .where('DOB', dob)
      .where('LastName', lastName)
      .orderBy('CollectionDateTime', 'DESC')
      .orderByRaw('COALESCE(ResultedDateTime, CURRENT_TIMESTAMP) DESC')
      .limit(1)

    if (rows.length === 0) {
      res.status(404).send("The requested test result was Not Found.")
      return
    }

    /** @namespace testResult.PatientName **/
    /** @namespace testResult.DOB **/
    /** @namespace testResult.CollectionDateTime **/
    /** @namespace testResult.ResultedDateTime **/
    /** @namespace testResult.Result **/
    /** @namespace testResult.SpecimenID **/
    const testResult = rows[0]

    if (testResult.Result && /^Negative\.?$/.test(String(testResult.Result).trim())) {
      const sqliteDb = app.get('sqliteDb')

      try {
        // Record the delivery of the Negative result, including the opaque Specimen ID.
        await sqliteDb('viewed_result')
          .insert({specimenId: testResult.SpecimenID})
      } catch (err) {
        // Not a service-breaking error, so log and continue.
        console.error(`Attempt to insert into viewed_result failed: ${err}`)
      }

      try {
        // Data retention period is 1 year.
        await sqliteDb('viewed_result')
          .where('viewedTime', '<', moment().subtract(1, 'year').toDate())
          .delete()
      } catch (err) {
        // Not a service-breaking error, so log and continue.
        console.error(`Attempt to delete from viewed_result failed: ${err}`)
      }

      const responseBody = {
        "patientName": testResult.PatientName.trim().toLowerCase().replace(/\w\S*/g, (w) => (w.replace(/^\w/, (c) => c.toUpperCase()))),
        "birthDate": testResult.DOB.substring(0, 4) + "-" + testResult.DOB.substring(4, 6) + '-' + testResult.DOB.substring(6, testResult.DOB.length),
        "collectionTimestamp": testResult.CollectionDateTime,
        "resultEnteredTimestamp": testResult.ResultedDateTime,
        "result": 'Negative',
      }

      res.status(200).json(responseBody)
    } else {
      // Response for any test result not explicitly Negative.
      res.status(204).send("The requested test result is Not Ready.")
    }
  } catch (err) {
    const msg = `Attempt to retrieve test result failed: ${err}`
    console.error(msg)
    res.status(500).send(msg)
  }
})


// Request an SMS notification once a test result is ready.
app.put('/notification-request', async (req, res) => {
  /** @namespace body.lastName **/
  /** @namespace body.healthCareNumber **/
  /** @namespace body.birthDate **/
  /** @namespace body.notificationTelephone **/
  /** @namespace body.preferredLanguage **/
  const {body} = req

  if (!body.lastName || !body.healthCareNumber || !body.birthDate || !body.notificationTelephone || !body.preferredLanguage) {
    res.status(400).send("Bad request")
    return
  }

  const healthCareNumber = body.healthCareNumber.replace(/-/g, '')
  const dob = body.birthDate.replace(/-/g, '')
  const lastName = body.lastName.toUpperCase()

  const mssqlDb = req.app.get('mssqlDb')
  const sqliteDb = app.get('sqliteDb')

  try {
    const rows = await mssqlDb.select('SpecimenID')
      .from('CovidTestResults')
      .where('HCN', healthCareNumber)
      .where('DOB', dob)
      .where('LastName', lastName)
      .orderBy('CollectionDateTime', 'DESC')
      .orderByRaw('COALESCE(ResultedDateTime, CURRENT_TIMESTAMP) DESC')
      .limit(1)

    if (rows.length === 0) {
      res.status(404).send("The requested test result was Not Found.")
      return
    }

    /** @namespace testResult.SpecimenID **/
    const testResult = rows[0]

    try {
      // Record the delivery of the Negative result, including the opaque Specimen ID.
      await sqliteDb('to_notify')
        .insert({specimenId: testResult.SpecimenID, notificationTelephone: body.notificationTelephone, preferredLanguage: body.preferredLanguage})
    } catch (err) {
      console.error(`Attempt to insert into to_notify failed: ${err}`)
      throw new Error('Unable to record the request for an SMS notification.')
    }

    try {
      // Data retention period is 1 year.
      await sqliteDb('to_notify')
        .where('requestTime', '<', moment().subtract(1, 'year').toDate())
        .delete()
    } catch (err) {
      // Not a service-breaking error, so log and continue.
      console.error(`Attempt to delete from to_notify failed: ${err}`)
    }

    res.status(200).send({message: "SMS notification has been requested."});
  } catch (err) {
    const msg = `Attempt to request an SMS notification failed: ${err}`
    console.error(msg)
    res.status(500).send(msg)
  }
})


// Retrieve the recent notification requests.
app.get('/to-notify', async (req, res) => {
  // open the database
  const db = await open({
    filename: './database.db',
    driver: sqlite3.Database
  })

  let errMessage = '';

  // Limit results to just the past week of notification requests.
  const query = `SELECT DISTINCT specimenId, notificationTelephone, preferredLanguage
                 FROM to_notify
                 WHERE specimenId IS NOT NULL
                   AND requestTime > DATE('now', '-7 days')`;

  const notifications = await db.all(query,
    (err) => {
    if (err) {
      errMessage = `Attempt to retrieve recent SMS notifications failed: ${err}`;
    }
  });

  if (errMessage !== '') {
    console.error(errMessage);
    res.status(500).send(errMessage);
    return;
  }

  res.status(200).send(notifications);
});


app.listen(port);
