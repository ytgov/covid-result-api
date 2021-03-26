# COVID-19 Test Result API

The middleware API service component for the Get a COVID-19 test result service.
This API is consumed by the
[Drupal 8 webforms site](http://eserv-prd-scm01.ynet.gov.yk.ca/services/service-yukon-ca--webform)
and also the
[SMS Notification scheduler](http://eserv-prd-scm01.ynet.gov.yk.ca/adhoc-services/notification-scheduler)
component.

The component exposes the API endpoints documented in
[Swagger](https://app.swaggerhub.com/apis/GOY/get-a-covid-19-test-result).

The component is intended to run from within a Docker container.

## Deployment

1. Pull the code from the Git repository.
2. Create the environment file from the template: `cp .env.base .env`
3. Populate the `.env` environment file with the Meditech test result database
   credentials.
4. Create `docker-compose.override.yml` from the instructions in `docker-compose.yml`
   and set the external port number.
5. Launch the container: `sudo docker-compose up --build -d`
6. Attach to a shell in the container image: `sudo docker exec -it <name> bash`
7. Install the NPM requirements: `npm install`
8. Exit the container and verify from a remote server that the component is responding
   and able to connect to the database:
   `curl -v http://<docker-server>:<external-port>/`. Expect an HTTP 200 response with
   the message "Successful Connection".

## Issues

The SQLite database is part of the repository.
It shouldn't be, but without it the Node.js code tends to create a directory rather than
an empty `database.db` file.
The version of the database in the repository is completely empty, and the tables are
created by the component as needed.
Care must be taken to not overwrite the database with the version in Git once the
service is running in production.
Release 2 of the project intends to migrate this data to an enterprise MSSQL database.
