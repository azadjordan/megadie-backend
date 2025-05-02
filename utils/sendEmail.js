import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

const sesClient = new SESClient({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const sendEmail = async ({ to, subject, html }) => {
  const text = "You’ve received a new quote request from a client.";

  const params = {
    Source: 'azadkkurdi@gmail.com',
    Destination: {
      ToAddresses: Array.isArray(to) ? to : [to]
    },
    Message: {
      Subject: { Data: subject },
      Body: {
        Html: { Data: html },
        Text: { Data: text }
      }
    }
  };

  try {
    const result = await sesClient.send(new SendEmailCommand(params));
    return result;
  } catch (err) {
    throw err;
  }
};

export default sendEmail;
