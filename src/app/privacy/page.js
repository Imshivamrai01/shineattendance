import Link from 'next/link';
import Logo from '@/components/Logo';

export const metadata = {
  title: 'Privacy Policy · Shine Attendance',
  description: 'How Shine Infosolutions collects, uses and protects information in the Shine Attendance app.',
};

const UPDATED = '6 October 2026';
const CONTACT = 'shineinfosolutions1@gmail.com';

function Section({ title, children }) {
  return (<section className="policy-section"><h2>{title}</h2>{children}</section>);
}

// Public page (no sign-in): linked from the login screen and used as the app's privacy policy URL.
export default function Privacy() {
  return (
    <main className="policy">
      <header className="policy-head">
        <Logo size={72} />
        <h1>Privacy Policy</h1>
        <p className="muted">Shine Attendance · Shine Infosolutions</p>
        <p className="muted small">Last updated: {UPDATED}</p>
      </header>

      <div className="card policy-body">
        <p>
          Shine Attendance is the attendance and workforce app of <b>Shine Infosolutions</b> (&quot;we&quot;, &quot;us&quot;). It is used by our
          employees and staff on the web at attendance.shineinfosolutions.in and through the Shine Attendance Android app. This policy
          explains what information the app collects, why, and the choices you have.
        </p>

        <Section title="1. Who can use the app">
          <p>The app is only for people who have been given an account by Shine Infosolutions. It is not intended for the general public or for anyone under 18.</p>
        </Section>

        <Section title="2. Information we collect">
          <ul>
            <li><b>Account and profile details</b>: name, employee ID, email, mobile number, role, department, designation, joining date, date of birth, address, parents&apos; names and emergency contacts that you or HR enter.</li>
            <li><b>Profile photo</b>: if you choose to add one.</li>
            <li><b>Attendance records</b>: the date and time of each check-in and check-out, hours worked, and any corrections with the reason.</li>
            <li><b>Location</b>: your device location when you check in and check out, and while you are checked in (see section 3).</li>
            <li><b>Check-in and check-out photos</b>: a photo taken with your camera at that moment, to confirm it is you.</li>
            <li><b>Work information</b>: daily tasks assigned to you and their status, and requests you submit (profile changes, attendance corrections).</li>
            <li><b>Technical information</b>: sign-in sessions, IP address and browser or device type, recorded with important actions for security.</li>
          </ul>
          <p>We do not collect your contacts, messages, files, or browsing activity outside this app.</p>
        </Section>

        <Section title="3. Location, including in the background">
          <p>
            Location is used for one purpose: to confirm that attendance is marked at the office. When you check in, the app compares your
            location with the office location. <b>While you are checked in</b>, the app continues to check your location so it can check you
            out automatically if you leave the office.
          </p>
          <p>
            In the Android app this continues <b>in the background, even when the app is closed or not in use</b>, and a notification
            (&quot;Shine Attendance: location on&quot;) is shown the whole time. Location reporting <b>stops when you check out</b> and at
            office closing time. The app does not track your location when you are not checked in.
          </p>
          <p>
            We store your location at check-in and check-out (and the distance from the office). The location checks in between are used
            only to decide whether you are still at the office and are not kept as a movement history.
          </p>
        </Section>

        <Section title="4. Camera">
          <p>The camera is used only when you check in or check out, or when you choose a profile photo. The app does not record video or take photos at any other time.</p>
        </Section>

        <Section title="5. How we use information">
          <ul>
            <li>To record attendance and working hours, and to produce attendance reports for management.</li>
            <li>To assign daily tasks and track their status.</li>
            <li>To send you notifications and emails about your own attendance, tasks and requests.</li>
            <li>To handle approvals, corrections and HR records.</li>
            <li>To keep accounts secure and to keep an audit trail of changes.</li>
          </ul>
          <p>We do not sell your information and we do not use it for advertising.</p>
        </Section>

        <Section title="6. Who can see your information">
          <p>
            You can see your own profile, attendance and tasks. Your HR, Manager, the COO and Admin of Shine Infosolutions can see the
            records of the people they are responsible for. Other employees cannot see your records.
          </p>
        </Section>

        <Section title="7. Service providers">
          <p>We use these services to run the app. They process data only on our behalf:</p>
          <ul>
            <li><b>Cloudflare</b>: hosting of the app and sending of emails.</li>
            <li><b>MongoDB Atlas</b>: the database.</li>
            <li><b>Cloudinary</b>: private storage of check-in, check-out and profile photos.</li>
            <li><b>Google Sheets</b>: a reporting copy of attendance, employee and task records in our company spreadsheet.</li>
            <li><b>WhatsApp Business (Meta)</b>: if we send you an official message on WhatsApp, your name and mobile number are used to deliver it.</li>
          </ul>
        </Section>

        <Section title="8. How long we keep information">
          <p>
            Records are kept while you work with Shine Infosolutions and afterwards for as long as needed for payroll, legal and audit
            purposes. Accounts of people who leave are deactivated; attendance and audit history is retained and not altered.
          </p>
        </Section>

        <Section title="9. Security">
          <p>
            The app is served over HTTPS. Passwords are stored only in hashed form and cannot be read by anyone, including us. Photos are
            stored privately and are shown only to signed-in people who are allowed to see them. Changes to records are logged.
          </p>
        </Section>

        <Section title="10. Your choices">
          <ul>
            <li>You can view your details in the app and ask for corrections through the app or HR.</li>
            <li>You can remove your profile photo at any time.</li>
            <li>You can turn off location or camera permission in your phone settings; attendance cannot be marked without them.</li>
            <li>To ask about, correct or delete your information, contact us at the address below. Some records must be kept for legal and payroll reasons.</li>
          </ul>
        </Section>

        <Section title="11. Changes to this policy">
          <p>If this policy changes, the new version will be published on this page with a new date.</p>
        </Section>

        <Section title="12. Contact">
          <p>Shine Infosolutions<br />Email: <a href={`mailto:${CONTACT}`}>{CONTACT}</a></p>
        </Section>
      </div>

      <p className="policy-foot"><Link href="/login">Back to sign in</Link></p>
    </main>
  );
}
