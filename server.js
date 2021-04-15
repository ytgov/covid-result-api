require('dotenv').config();

let knex = require('knex');
let express = require('express');
let app = express();
let port = process.env.PORT || 3000;

let sqlite3 = require('sqlite3');
sqlite3.verbose();
let open = require('sqlite').open;

// this is a top-level await 
(async () => {
  // open the database
  const db = await open({
    filename: './database.db',
    driver: sqlite3.Database
  })

  // Requests for SMS notification.
  await db.run(`CREATE TABLE IF NOT EXISTS to_notify
                (
                    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
                    requestTime           TIMESTAMP DATE DEFAULT (DATETIME('now')),
                    preferredLanguage     TEXT,
                    notificationTelephone TEXT,
                    specimenId            TEXT
                )`,
    (err) => {
      if (err) {
        console.error(`Attempt to create to_notify table failed: ${err}`)
      }
    }
  );

  // Delivery of Negative test results.
  await db.run(`CREATE TABLE IF NOT EXISTS viewed_result
                (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    viewedTime TIMESTAMP DATE DEFAULT (DATETIME('now')),
                    specimenId INTEGER
                )`,
    (err) => {
      if (err) {
        console.error(`Attempt to create viewed_result table failed: ${err}`)
      }
    }
  );

})();


app.use(express.json()) // for parsing application/json
app.use(express.urlencoded({extended: true})) // for parsing application/x-www-form-urlencoded

let conn = knex({
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
});

app.set("db", conn);


// Verify connection to database and existing data for necessary columns.
app.get('/status', function (req, res) {
  const db = req.app.get('db');

  db.select('PatientName', 'DOB', 'CollectionDateTime', 'ResultedDateTime', 'Result', 'SpecimenID')
    .from('CovidTestResults')
    .limit(5)
    .then(rows => {
      if (rows.length === 5) {
        const msg = 'API status verified.'
        console.log(msg);
        res.status(200).send(msg);
      } else {
        throw new Error('Unexpected number of test results in database.');
      }
    })
    .catch((err) => {
      const msg = `Attempt to verify API status failed: ${err}`;
      console.error(msg);
      res.status(500).send(msg);
    })
});


// Retrieve a test result.
app.put('/test-result', (req, res) => {
  const db = req.app.get('db');

  /** @namespace body.lastName **/
  /** @namespace body.healthCareNumber **/
  /** @namespace body.birthDate **/
  const {body} = req;

  if (!body.lastName || !body.healthCareNumber || !body.birthDate) {
    res.status(400).send("Bad request");
    return
  }

  const healthCareNumber = body.healthCareNumber.replace(/-/g, '');
  const dob = body.birthDate.replace(/-/g, '');
  const lastName = body.lastName.toUpperCase();

  db.select('PatientName', 'DOB', 'CollectionDateTime', 'ResultedDateTime', 'Result', 'SpecimenID')
    .from('CovidTestResults')
    .where('HCN', healthCareNumber)
    .where('DOB', dob)
    .where('LastName', lastName)
    .orderBy('CollectionDateTime', 'DESC')
    .orderByRaw('COALESCE(ResultedDateTime, CURRENT_TIMESTAMP) DESC')
    .limit(1)
    .then(rows => {
      if (rows.length === 0) {
        res.status(404).send("The requested test result was Not Found.");
        return;
      }

      /** @namespace testResult.PatientName **/
      /** @namespace testResult.DOB **/
      /** @namespace testResult.CollectionDateTime **/
      /** @namespace testResult.ResultedDateTime **/
      /** @namespace testResult.Result **/
      /** @namespace testResult.SpecimenID **/
      const testResult = rows[0];

      if (testResult.Result && /^Negative\.?$/.test(String(testResult.Result).trim())) {
        // Record the delivery of the Negative result, including the opaque Specimen ID.
        (async () => {
          const db = await open({
            filename: './database.db',
            driver: sqlite3.Database
          });

          const dbInsert = 'INSERT INTO viewed_result (specimenId) VALUES (?)';
          await db.run(dbInsert, [testResult.SpecimenID],
            (err) => {
              if (err) {
                console.error(`Attempt to insert into viewed_result failed: ${err}`)
              }
            });

          // Data retention period is 1 year.
          const dbDelete = "DELETE FROM viewed_result WHERE viewedTime < DATE('now', '-1 year')";
          await db.run(dbDelete, [],
            (err) => {
              if (err) {
                console.error(`Attempt to delete from viewed_result failed: ${err}`)
              }
            });
        })();

        const responseBody = {
          "patientName": testResult.PatientName.trim().toLowerCase().replace(/\w\S*/g, (w) => (w.replace(/^\w/, (c) => c.toUpperCase()))),
          "birthDate": testResult.DOB.substring(0, 4) + "-" + testResult.DOB.substring(4, 6) + '-' + testResult.DOB.substring(6, testResult.DOB.length),
          "collectionTimestamp": testResult.CollectionDateTime,
          "resultEnteredTimestamp": testResult.ResultedDateTime,
          "result": 'Negative',
        }

        res.status(200).json(responseBody);
        return;
      }

      res.status(204).send("The requested test result is Not Ready.");
    })
    .catch((err) => {
      const msg = `Attempt to retrieve test result failed: ${err}`;
      console.error(msg);
      res.status(500).send(msg);
    })
});


// Request an SMS notification once a test result is ready.
app.put('/notification-request', async (req, res) => {
  const db = req.app.get('db');

  /** @namespace body.lastName **/
  /** @namespace body.healthCareNumber **/
  /** @namespace body.birthDate **/
  /** @namespace body.notificationTelephone **/
  /** @namespace body.preferredLanguage **/
  const {body} = req;

  if (!body.lastName || !body.healthCareNumber || !body.birthDate || !body.notificationTelephone || !body.preferredLanguage) {
    res.status(400).send("Bad request");
    return
  }

  const healthCareNumber = body.healthCareNumber.replace(/-/g, '');
  const dob = body.birthDate.replace(/-/g, '');
  const lastName = body.lastName.toUpperCase();

  db.select('SpecimenID')
    .from('CovidTestResults')
    .where('HCN', healthCareNumber)
    .where('DOB', dob)
    .where('LastName', lastName)
    .orderBy('CollectionDateTime', 'DESC')
    .orderByRaw('COALESCE(ResultedDateTime, CURRENT_TIMESTAMP) DESC')
    .limit(1)
    .then(rows => {
      if (rows.length === 0) {
        res.status(404).send("The requested test result was Not Found.");
        return;
      }

      /** @namespace testResult.SpecimenID **/
      const testResult = rows[0];

      (async () => {
        const db = await open({
          filename: './database.db',
          driver: sqlite3.Database
        })

        let dbInsert = 'INSERT INTO to_notify (specimenId, notificationTelephone, preferredLanguage) VALUES (?,?,?)';
        await db.run(dbInsert, [testResult.SpecimenID, body.notificationTelephone, body.preferredLanguage],
          (err) => {
            if (err) {
              console.error(`Attempt to insert into to_notify failed: ${err}`)
            }
          });

        // Data retention period is 1 year.
        const dbDelete = "DELETE FROM to_notify WHERE requestTime < DATE('now', '-1 year')";
        await db.run(dbDelete, [],
          (err) => {
            if (err) {
              console.error(`Attempt to delete from to_notify failed: ${err}`)
            }
          });

        res.status(200).send({message: "SMS notification has been requested."});
      })();

    })
    .catch((e) => {
      const msg = `Attempt to request an SMS notification failed: ${err}`;
      console.error(msg);
      res.status(500).send(msg);
    })
});

app.get('/to-notify', async (req, res) => {
  // open the database
  const db = await open({
    filename: './database.db',
    driver: sqlite3.Database
  })

  const query = 'Select specimenId, notificationTelephone, preferredLanguage from to_notify where specimenId is not null';
  const result = await db.all(query);
  res.status(200).send(result);
});

console.log(`Database Info: ${process.env.DB_HOST} ${process.env.DB_NAME}`)

app.listen(port);
