import { useEffect, useMemo, useState } from 'react';
import { csvParse } from 'd3-dsv';
import './App.css';
import { db, isFirebaseReady } from './firebase';
import {
  addDoc,
  arrayUnion,
  collection,
  doc,
  getDocs,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';

const normalizeHeader = (value = '') =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '');

const getValue = (row, headerCandidates) => {
  const rowEntries = Object.entries(row || {});

  for (const [header, value] of rowEntries) {
    const normalized = normalizeHeader(header);
    if (headerCandidates.includes(normalized)) {
      return `${value || ''}`.trim();
    }
  }

  return '';
};

const extractStudentNumber = ({ row, email }) => {
  const directValue = getValue(row, [
    'studentnumber',
    'studentid',
    'studentno',
    'idnumber',
  ]);

  if (directValue) return directValue;

  if (!email) return '';

  const localPart = email.split('@')[0] || '';
  const numberMatch = localPart.match(/\d+/);
  return numberMatch ? numberMatch[0] : localPart;
};

const createAthleteKey = ({ studentNumber, firstName, lastName, email }) => {
  if (studentNumber) return `id_${studentNumber}`;
  if (email) return `email_${email.toLowerCase()}`;

  return `name_${`${firstName}_${lastName}`
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')}`;
};

const mapRosterRow = (row, sourceFile) => {
  const team = getValue(row, ['group', 'team', 'squad']);
  const firstName = getValue(row, ['studentfirstname', 'firstname', 'first']);
  const lastName = getValue(row, ['studentlastname', 'lastname', 'last']);
  const otherName = getValue(row, ['studentothername', 'middlename', 'othername']);
  const gender = getValue(row, ['gender', 'sex']);
  const email = getValue(row, ['studentemailaddress', 'email', 'studentemail']);
  const grade = getValue(row, ['yeargrade', 'grade', 'year']);
  const studentNumber = extractStudentNumber({ row, email });

  const hasUsefulData =
    !!team || !!firstName || !!lastName || !!email || !!studentNumber;

  if (!hasUsefulData) {
    return null;
  }

  return {
    team,
    firstName,
    lastName,
    otherName,
    gender,
    email,
    grade,
    studentNumber,
    athleteKey: createAthleteKey({ studentNumber, firstName, lastName, email }),
    sourceFile,
  };
};

const parseCsvFile = async (file) => {
  const text = await file.text();
  return csvParse(text);
};

const getErrorMessage = (error) => {
  if (!error) return 'Unknown error.';
  if (typeof error === 'string') return error;
  if (error.code) return `${error.code}: ${error.message}`;
  return error.message || 'Unknown error.';
};

function App() {
  const [allAthletes, setAllAthletes] = useState([]);
  const [isLoadingFirebase, setIsLoadingFirebase] = useState(isFirebaseReady);
  const [uploadStatus, setUploadStatus] = useState(
    isFirebaseReady
      ? 'Loading athletes from Firebase...'
      : 'Firebase not configured yet. Upload will parse/preview only until .env is set.'
  );
  const [isUploading, setIsUploading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTeam, setFilterTeam] = useState('');

  const canUpload = !isUploading;

  // Fetch all athletes from Firestore on mount
  useEffect(() => {
    if (!isFirebaseReady) {
      setIsLoadingFirebase(false);
      return;
    }

    const loadAthletesFromFirebase = async () => {
      try {
        const snapshot = await getDocs(collection(db, 'athletes'));
        const athletes = snapshot.docs.map((docSnap) => {
          const data = docSnap.data();
          return {
            athleteKey: docSnap.id,
            studentNumber: data.studentNumber || '',
            firstName: data.firstName || '',
            lastName: data.lastName || '',
            email: data.email || '',
            grade: data.grade || '',
            gender: data.gender || '',
            teams: Array.isArray(data.teams) ? data.teams : [],
            team: Array.isArray(data.teams) ? data.teams[0] : '',
            sourceFile: Array.isArray(data.sourceFiles) ? data.sourceFiles[0] : '',
          };
        });
        setAllAthletes(athletes);
        setUploadStatus(`Loaded ${athletes.length} athletes from Firebase.`);
      } catch (error) {
        setUploadStatus(`Failed to load athletes: ${getErrorMessage(error)}`);
      } finally {
        setIsLoadingFirebase(false);
      }
    };

    loadAthletesFromFirebase();
  }, []);

  // Filter and search rows
  const filteredRows = useMemo(() => {
    return allAthletes.filter((row) => {
      const matchesSearch =
        !searchQuery ||
        row.firstName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        row.lastName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        row.studentNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
        row.email.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesTeamFilter = !filterTeam || row.teams.includes(filterTeam);

      return matchesSearch && matchesTeamFilter;
    });
  }, [allAthletes, searchQuery, filterTeam]);

  // Get all unique teams for filter dropdown
  const uniqueTeams = useMemo(() => {
    const teams = new Set();
    allAthletes.forEach((athlete) => {
      athlete.teams.forEach((team) => teams.add(team));
    });
    return Array.from(teams).sort();
  }, [allAthletes]);

  const displaySummary = useMemo(() => {
    const displayedTeams = new Set(filteredRows.map((row) => row.team).filter(Boolean));
    const displayedAthletes = new Set(filteredRows.map((row) => row.athleteKey));

    return {
      teamCount: displayedTeams.size,
      athleteCount: displayedAthletes.size,
      rowCount: filteredRows.length,
    };
  }, [filteredRows]);

  const persistRowsToFirebase = async (mappedRows, fileName) => {
    const uploadRef = await addDoc(collection(db, 'uploads'), {
      fileName,
      uploadedAt: serverTimestamp(),
      rowCount: mappedRows.length,
      teamCount: new Set(mappedRows.map((row) => row.team).filter(Boolean)).size,
    });

    const athleteWrites = mappedRows.map((row) => {
      const athleteRef = doc(collection(db, 'athletes'), row.athleteKey);
      const athletePayload = {
        studentNumber: row.studentNumber || null,
        firstName: row.firstName || null,
        lastName: row.lastName || null,
        otherName: row.otherName || null,
        gender: row.gender || null,
        email: row.email || null,
        grade: row.grade || null,
        sourceFiles: arrayUnion(fileName),
        uploadIds: arrayUnion(uploadRef.id),
        updatedAt: serverTimestamp(),
      };

      if (row.team) {
        athletePayload.teams = arrayUnion(row.team);
      }

      return setDoc(
        athleteRef,
        athletePayload,
        { merge: true }
      );
    });

    await Promise.all(athleteWrites);

    return uploadRef.id;
  };

  const handleFilesUpload = async (event) => {
    const files = Array.from(event.target.files || []);

    if (!files.length) return;

    setIsUploading(true);
    setUploadStatus(
      isFirebaseReady ? 'Parsing and uploading...' : 'Parsing files (Firebase save is disabled)...'
    );

    const allMappedRows = [];

    try {
      for (const file of files) {
        const rows = await parseCsvFile(file);

        const mappedRows = rows
          .map((row) => mapRosterRow(row, file.name))
          .filter(Boolean);

        if (!mappedRows.length) {
          continue;
        }

        if (isFirebaseReady) {
          await persistRowsToFirebase(mappedRows, file.name);
        }

        allMappedRows.push(...mappedRows);
      }

      if (!allMappedRows.length) {
        setUploadStatus('No valid athlete rows were found in the selected files.');
      } else if (!isFirebaseReady) {
        setUploadStatus(
          `Parsed ${allMappedRows.length} rows from ${files.length} file(s). Configure Firebase .env to enable saving.`
        );
      } else {
        // Reload athletes from Firebase to show newly uploaded data
        const snapshot = await getDocs(collection(db, 'athletes'));
        const athletes = snapshot.docs.map((docSnap) => {
          const data = docSnap.data();
          return {
            athleteKey: docSnap.id,
            studentNumber: data.studentNumber || '',
            firstName: data.firstName || '',
            lastName: data.lastName || '',
            email: data.email || '',
            grade: data.grade || '',
            gender: data.gender || '',
            teams: Array.isArray(data.teams) ? data.teams : [],
            team: Array.isArray(data.teams) ? data.teams[0] : '',
            sourceFile: Array.isArray(data.sourceFiles) ? data.sourceFiles[0] : '',
          };
        });
        setAllAthletes(athletes);
        setSearchQuery('');
        setFilterTeam('');
        setUploadStatus(
          `Upload complete. Saved ${allMappedRows.length} rows from ${files.length} file(s) to Firebase.`
        );
      }
    } catch (error) {
      setUploadStatus(`Upload failed: ${getErrorMessage(error)}`);
    } finally {
      setIsUploading(false);
      event.target.value = '';
    }
  };

  return (
    <div className="page-shell">
      <main className="tracker-card">
        <h1>Athlete tracker</h1>

        <section className="controls-row">
          <div className="search-column">
            <input
              type="text"
              className="search-input"
              placeholder="Search bar"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <select
              className="filter-button"
              value={filterTeam}
              onChange={(e) => setFilterTeam(e.target.value)}
            >
              <option value="">filter by team</option>
              {uniqueTeams.map((team) => (
                <option key={team} value={team}>
                  {team}
                </option>
              ))}
            </select>
          </div>

          <label className={`upload-box ${!canUpload ? 'disabled' : ''}`}>
            <input
              type="file"
              accept=".csv,text/csv"
              multiple
              onChange={handleFilesUpload}
              disabled={!canUpload}
            />
            {isUploading ? 'Uploading...' : 'Upload data'}
          </label>
        </section>

        <p className="status-text">{uploadStatus}</p>

        <section className="preview-card">
          <div className="preview-header">
            <h2>Spreadsheet preview</h2>
            <div className="preview-meta">
              <span>Rows: {displaySummary.rowCount}</span>
              <span>Athletes: {displaySummary.athleteCount}</span>
              <span>Teams: {displaySummary.teamCount}</span>
            </div>
          </div>

          {filteredRows.length === 0 ? (
            <p className="empty-state">
              {isLoadingFirebase
                ? 'Loading athletes...'
                : allAthletes.length === 0
                ? 'Upload one or more CSV files to preview parsed data.'
                : 'No athletes match your search or filter.'}
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Student Number</th>
                    <th>First Name</th>
                    <th>Last Name</th>
                    <th>Email</th>
                    <th>Grade</th>
                    <th>Team</th>
                    <th>Source File</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.slice(0, 120).map((row, index) => (
                    <tr key={`${row.athleteKey}-${row.team}-${index}`}>
                      <td>{row.studentNumber}</td>
                      <td>{row.firstName}</td>
                      <td>{row.lastName}</td>
                      <td>{row.email}</td>
                      <td>{row.grade}</td>
                      <td>{row.team}</td>
                      <td>{row.sourceFile}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
