require('dotenv').config();

var knex = require('knex');
var express = require('express');
var app = express();
var port = process.env.PORT || 3000;

var sqlite3 = require('sqlite3');
sqlite3.verbose();
var open = require('sqlite').open;

// this is a top-level await 
(async () => {
  // open the database
  const db = await open({
    filename: './database.db',
    driver: sqlite3.Database
  })

  await db.run(`CREATE TABLE IF NOT EXISTS to_notify (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    requestTime timestamp DATE DEFAULT (DATETIME('now')),
    preferredLanguage text, 
    notificationTelephone text, 
    specimenId text)`,
    (err) => {
      if (err) {
          console.log("🚀 ----------------------------------------")
          console.log("🚀 ~ file: server.js ~ line 27 ~ err", err)
          console.log("🚀 ----------------------------------------")
          // Table already created
      } else {
          // Table just created, creating some rows
      }
    }
  );

  // Record delivery of Negative test results, as well as the status of the
  // submittedOnBehalf flag.
  await db.run(`CREATE TABLE IF NOT EXISTS viewed_result (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    viewedTime timestamp DATE DEFAULT (DATETIME('now')),
    submittedOnBehalf integer,
    specimenId integer)`,
    (err) => {
      if (err) {
        console.log("🚀 ----------------------------------------")
        console.log("🚀 ~ file: server.js ~ line 43 ~ err", err)
        console.log("🚀 ----------------------------------------")
        // Table already created
      } else {
        // Table just created, creating some rows
      }
    }
  );

})();


app.use(express.json()) // for parsing application/json
app.use(express.urlencoded({ extended: true })) // for parsing application/x-www-form-urlencoded

var conn = knex({
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

// URI for tediousJS = `mssql://${process.env.DB_USER}:${process.env.DB_PASS}@${process.env.DB_HOST}/${process.env.DB_NAME}?encrypt=true`
app.get('/status', function (req, res) {
  const db = req.app.get('db');

  // (async function () {
  // })()

  db.raw("SELECT TOP 5 PatientName, DOB, CollectionDateTime, ResultedDateTime, Result, SpecimenID FROM dbo.CovidTestResults;")
    .then(rows => {
      if (rows.length > 0) { 
        res.status(200).send("Successful Connection");
        return
      }
    })
    .catch((e) => {
      console.error(e);
      res.status(500).send("ERROR: Either the connection to the database isn't working or the query is incorrect");
    })
});

app.put('/test-result', (req, res) => {
  const db = req.app.get('db');
  const { body } = req;

  if (!body.lastName || !body.healthCareNumber || !body.birthDate) {
    res.status(400).send("Bad request");
    return
  }

  const healthCareNumber = body.healthCareNumber.replace(/-/g, '');
  const dob = body.birthDate.replace(/-/g, '');
  const lastName = body.lastName;
  const submittedOnBehalf = body.submittedOnBehalf;

  db.raw(`
    SELECT  TOP 1 PatientName, DOB, CollectionDateTime, ResultedDateTime, Result, SpecimenID
    FROM    dbo.CovidTestResults
    WHERE   HCN = '${healthCareNumber}'
    AND     DOB = '${dob}'
    AND     LastName = '${lastName.toUpperCase()}'
    ORDER   BY CollectionDateTime DESC, COALESCE(ResultedDateTime, CURRENT_TIMESTAMP) DESC;`)
    .then(rows => {
      if (rows.length === 0) {
        res.status(404).send("No matching result found for testee token fields");
        return;
      }

      const result = rows[0];

      if (result.Result && /^Negative\.?$/.test(String(result.Result).trim())) {
        // Record the delivery of the Negative result, including the opaque Specimen ID.
        (async () => {
          const db = await open({
            filename: './database.db',
            driver: sqlite3.Database
          })

          let dbInsert = 'INSERT INTO viewed_result (submittedOnBehalf, specimenId) VALUES (?,?)';
          const dbInsertResult = await db.run(dbInsert, [(submittedOnBehalf ? 1 : 0), result.SpecimenID]);
          console.log("🚀 ~ file: server.js ~ INSERT INTO viewed_result ~ result", dbInsertResult);

          // Data retention period is 1 year.
          let dbDelete = "DELETE FROM viewed_result WHERE viewedTime < DATE('now', '-1 year')";
          const dbDeleteResult = await db.run(dbDelete);
          console.log("🚀 ~ file: server.js ~ DELETE FROM viewed_result ~ result", dbDeleteResult);
        })();

        const responseBody = {
          "patientName": result.PatientName.trim().toLowerCase().replace(/\w\S*/g, (w) => (w.replace(/^\w/, (c) => c.toUpperCase()))),
          "birthDate": result.DOB.substring(0, 4) + "-" + result.DOB.substring(4, 6) + '-' + result.DOB.substring(6, result.DOB.length),
          "collectionTimestamp": result.CollectionDateTime,
          "resultEnteredTimestamp": result.ResultedDateTime,
          "result": 'Negative',
        }

        res.status(200).json(responseBody);
        return;
      }

      res.status(204).send("The test result is not yet ready.");
    })
    .catch((e) => {
      console.error(e);
      res.status(500).send("ERROR: Either the connection to the database isn't working or the query is incorrect");
    })
});

app.put('/notification-request', async (req, res) => {
  const msdb = req.app.get('db');
  const { body } = req;

  if (!body.lastName || !body.healthCareNumber || !body.birthDate || !body.notificationTelephone || !body.preferredLanguage) {
    res.status(400).send("Bad request");
    return
  }

  const healthCareNumber = body.healthCareNumber.replace(/-/g, '');
  const dob = body.birthDate.replace(/-/g, '');
  const lastName = body.lastName;

  msdb.raw(`
    SELECT *
      FROM dbo.CovidTestResults
      WHERE dbo.CovidTestResults.HCN = '${healthCareNumber}' AND
        dbo.CovidTestResults.DOB = '${dob}' AND
        dbo.CovidTestResults.LastName = '${lastName.toUpperCase()}';`)
    .then(rows => {
      // if (rows.length == 0) { 
      //   res.status(404).send("No matching result found for testee token fields");
      //   return
      // }
      const result = rows[0] || {};
      const specimenId = result.SpecimenID;

      (async () => {
        // open the database
        const db = await open({
          filename: './database.db',
          driver: sqlite3.Database
        })

        let dbInsert = 'INSERT INTO to_notify (specimenId, notificationTelephone, preferredLanguage) VALUES (?,?,?)';
        const dbInsertResult = await db.run(dbInsert, [specimenId, body.notificationTelephone, body.preferredLanguage]);
        console.log("🚀 ~ file: server.js ~ INSERT INTO to_notify ~ result", dbInsertResult);

        // Data retention period is 1 year.
        let dbDelete = "DELETE FROM to_notify WHERE requestTime < DATE('now', '-1 year')";
        const dbDeleteResult = await db.run(dbDelete);
        console.log("🚀 ~ file: server.js ~ DELETE FROM to_notify ~ result", dbDeleteResult);

        res.status(200).send({ message: "Successfully requested" });
      })();
    
    })
    .catch((e) => {
      console.error(e);
      res.status(500).send("ERROR: Either the connection to the database isn't working or the query is incorrect");
    })
});

app.get('/to-notify', async (req, res) => {
  // open the database
  const db = await open({
    filename: './database.db',
    driver: sqlite3.Database
  })

  var query = 'Select specimenId, notificationTelephone, preferredLanguage from to_notify where specimenId is not null';
  const result = await db.all(query);
  res.status(200).send(result);
});

console.log(`Database Info: ${process.env.DB_HOST} ${process.env.DB_NAME}`)

app.listen(port);
