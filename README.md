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
4. Copy `database.db.sample` to `database.db` which will be the running SQLite database
   file. The database is initially empty.
5. Create `docker-compose.override.yml` from the instructions in `docker-compose.yml`
   and set the external port number.
6. Launch the container: `sudo docker-compose up --build -d`
7. Attach to a shell in the container image: `sudo docker exec -it <name> bash`
8. Install the NPM requirements: `npm install`
9. Exit the container and verify from a remote server that the component is responding
   and able to connect to the database:
   `curl -v http://<docker-server>:<external-port>/`. Expect an HTTP 200 response with
   the message "Successful Connection".
