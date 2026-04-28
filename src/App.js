import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import './App.css';
import AuthButton from './components/AuthButton';
import { auth, db, isFirebaseReady } from './firebase';
import {
  addDoc,
  arrayUnion,
  collection,
  doc,
  getDocs,
  serverTimestamp,
  setDoc,
} from 'firebase/firestore';
import { onAuthStateChanged, signOut } from 'firebase/auth';

const normalizeHeader = (value = '') =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '');

const parseCsvText = (text = '') => {
  const lines = `${text}`
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((line, index, allLines) => line.trim() || index < allLines.length - 1);

  if (!lines.length) {
    return [];
  }

  const parseLine = (line) => {
    const values = [];
    let currentValue = '';
    let inQuotes = false;

    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];
      const nextCharacter = line[index + 1];

      if (character === '"') {
        if (inQuotes && nextCharacter === '"') {
          currentValue += '"';
          index += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }

      if (character === ',' && !inQuotes) {
        values.push(currentValue);
        currentValue = '';
        continue;
      }

      currentValue += character;
    }

    values.push(currentValue);
    return values.map((value) => value.trim());
  };

  const headers = parseLine(lines[0]);

  return lines.slice(1).map((line) => {
    const values = parseLine(line);

    return headers.reduce((row, header, index) => {
      if (header) {
        row[header] = values[index] ?? '';
      }
      return row;
    }, {});
  });
};

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
  const birthdate = getValue(row, ['birthdate', 'dateofbirth', 'dob', 'studentbirthdate']);
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
    birthdate,
    studentNumber,
    athleteKey: createAthleteKey({ studentNumber, firstName, lastName, email }),
    sourceFile,
  };
};

const parseSpreadsheetFile = async (file) => {
  const lowerName = (file.name || '').toLowerCase();
  const isExcelFile = lowerName.endsWith('.xlsx') || lowerName.endsWith('.xls');

  if (!isExcelFile) {
    const text = await file.text();
    return parseCsvText(text);
  }

  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) {
    return [];
  }

  return XLSX.utils.sheet_to_json(workbook.Sheets[firstSheetName], {
    defval: '',
  });
};

const getErrorMessage = (error) => {
  if (!error) return 'Unknown error.';
  if (typeof error === 'string') return error;
  if (error.code) return `${error.code}: ${error.message}`;
  return error.message || 'Unknown error.';
};

const hydrateAthlete = (athleteKey, data) => ({
  athleteKey,
  studentNumber: data.studentNumber || '',
  firstName: data.firstName || '',
  lastName: data.lastName || '',
  email: data.email || '',
  grade: data.grade || '',
  gender: data.gender || '',
  birthdate: data.birthdate || '',
  teams: Array.isArray(data.teams) ? data.teams : [],
  team: Array.isArray(data.teams) ? data.teams[0] : '',
  sourceFile: Array.isArray(data.sourceFiles) ? data.sourceFiles[0] : '',
});

const normalizeSearchValue = (value = '') => `${value}`.trim().toLowerCase();

const splitCommaTerms = (value = '') =>
  value
    .split(',')
    .map((term) => normalizeSearchValue(term))
    .filter(Boolean);

const tableColumns = [
  { id: 'studentNumber', label: 'Student Number' },
  { id: 'firstName', label: 'First Name' },
  { id: 'lastName', label: 'Last Name' },
  { id: 'email', label: 'Email' },
  { id: 'birthdate', label: 'Birthdate' },
  { id: 'grade', label: 'Grade' },
  { id: 'team', label: 'Team' },
  { id: 'sourceFile', label: 'Source File' },
];

const defaultVisibleColumns = tableColumns.reduce((acc, column) => {
  acc[column.id] = true;
  return acc;
}, {});

const isAllowedHkisEmail = (email = '') => {
  const [, domain = ''] = `${email}`.toLowerCase().split('@');
  return domain === 'hkis.edu.hk' || domain.endsWith('.hkis.edu.hk');
};

function App() {
  const [allAthletes, setAllAthletes] = useState([]);
  const [user, setUser] = useState(null);
  const [isLoadingFirebase, setIsLoadingFirebase] = useState(isFirebaseReady);
  const [uploadStatus, setUploadStatus] = useState(
    isFirebaseReady
      ? 'Loading athletes from Firebase...'
      : 'Firebase not configured yet. Upload will parse/preview only until .env is set.'
  );
  const [isUploading, setIsUploading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterTeam, setFilterTeam] = useState('');
  const [filterGrade, setFilterGrade] = useState('');
  const [filterBirthdate, setFilterBirthdate] = useState('');
  const [visibleColumns, setVisibleColumns] = useState(defaultVisibleColumns);

  const canUpload = !isUploading && !!user;

  useEffect(() => {
    if (!auth) {
      setUser(null);
      return undefined;
    }

    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser && !isAllowedHkisEmail(currentUser.email)) {
        setUser(null);
        setAllAthletes([]);
        setUploadStatus('Access denied. Please sign in with an @hkis.edu.hk account.');
        await signOut(auth);
        return;
      }

      setUser(currentUser);

      if (!currentUser && isFirebaseReady) {
        setUploadStatus('Sign in with your HKIS Google account to load athlete data.');
      }
    });

    return () => unsubscribe();
  }, []);

  // Load athletes whenever auth state changes
  useEffect(() => {
    if (!isFirebaseReady) {
      setIsLoadingFirebase(false);
      return;
    }

    if (!user) {
      setAllAthletes([]);
      setIsLoadingFirebase(false);
      setSearchQuery('');
      setFilterTeam('');
      setFilterGrade('');
      setFilterBirthdate('');
      return;
    }

    let cancelled = false;
    setIsLoadingFirebase(true);
    setUploadStatus('Loading athletes from Firebase...');

    const loadAthletesFromFirebase = async () => {
      try {
        const snapshot = await getDocs(collection(db, 'athletes'));
        const athletes = snapshot.docs.map((docSnap) => hydrateAthlete(docSnap.id, docSnap.data()));
        if (cancelled) return;
        setAllAthletes(athletes);
        setUploadStatus(`Loaded ${athletes.length} athletes from Firebase.`);
      } catch (error) {
        if (cancelled) return;
        setUploadStatus(`Failed to load athletes: ${getErrorMessage(error)}`);
      } finally {
        if (cancelled) return;
        setIsLoadingFirebase(false);
      }
    };

    loadAthletesFromFirebase();

    return () => {
      cancelled = true;
    };
  }, [user]);

  // Filter and search rows
  const filteredRows = useMemo(() => {
    const queryTerms = splitCommaTerms(searchQuery);
    const hasSearchTerms = queryTerms.length > 0;
    const normalizedBirthdateFilter = normalizeSearchValue(filterBirthdate);

    return allAthletes.filter((row) => {
      const searchableValues = [
        row.firstName,
        row.lastName,
        row.studentNumber,
        row.email,
        `${row.firstName || ''} ${row.lastName || ''}`,
      ]
        .map((value) => normalizeSearchValue(value))
        .filter(Boolean);

      const matchesSearch =
        !hasSearchTerms ||
        queryTerms.some((term) => searchableValues.some((value) => value.includes(term)));

      const matchesTeamFilter = !filterTeam || row.teams.includes(filterTeam);
      const matchesGradeFilter = !filterGrade || normalizeSearchValue(row.grade) === normalizeSearchValue(filterGrade);
      const matchesBirthdateFilter =
        !normalizedBirthdateFilter || normalizeSearchValue(row.birthdate).includes(normalizedBirthdateFilter);

      return matchesSearch && matchesTeamFilter && matchesGradeFilter && matchesBirthdateFilter;
    });
  }, [allAthletes, searchQuery, filterTeam, filterGrade, filterBirthdate]);

  // Get all unique teams for filter dropdown
  const uniqueTeams = useMemo(() => {
    const teams = new Set();
    allAthletes.forEach((athlete) => {
      athlete.teams.forEach((team) => teams.add(team));
    });
    return Array.from(teams).sort();
  }, [allAthletes]);

  const uniqueGrades = useMemo(() => {
    const grades = new Set();
    allAthletes.forEach((athlete) => {
      if (athlete.grade) {
        grades.add(athlete.grade);
      }
    });
    return Array.from(grades).sort();
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

  const renderedColumns = useMemo(
    () => tableColumns.filter((column) => visibleColumns[column.id]),
    [visibleColumns]
  );

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
        birthdate: row.birthdate || null,
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
    if (!user) {
      setUploadStatus('Sign in with your HKIS Google account to upload athlete data.');
      event.target.value = '';
      return;
    }

    setIsUploading(true);
    setUploadStatus(
      isFirebaseReady ? 'Parsing and uploading...' : 'Parsing files (Firebase save is disabled)...'
    );

    const allMappedRows = [];

    try {
      for (const file of files) {
        const rows = await parseSpreadsheetFile(file);

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
        setAllAthletes(allMappedRows);
        setSearchQuery('');
        setFilterTeam('');
        setFilterGrade('');
        setFilterBirthdate('');
        setUploadStatus(
          `Parsed ${allMappedRows.length} rows from ${files.length} file(s). Configure Firebase .env to enable saving.`
        );
      } else {
        // Reload athletes from Firebase to show newly uploaded data
        const snapshot = await getDocs(collection(db, 'athletes'));
        const athletes = snapshot.docs.map((docSnap) => hydrateAthlete(docSnap.id, docSnap.data()));
        setAllAthletes(athletes);
        setSearchQuery('');
        setFilterTeam('');
        setFilterGrade('');
        setFilterBirthdate('');
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

  const handleToggleColumn = (columnId) => {
    setVisibleColumns((current) => ({
      ...current,
      [columnId]: !current[columnId],
    }));
  };

  return (
    <div className="page-shell">
      <main className="tracker-card">
          <AuthButton user={user} isFirebaseReady={isFirebaseReady} />
          <div className="dragon-badge" aria-hidden="true">
            <span className="dragon-icon">GO DRAGONS</span>
            <span className="dragon-glyph">🐉</span>
          </div>
        <h1>Athlete tracker</h1>

        {!user && (
          <p className="status-text">
            Sign in with Google to upload and sync athlete data.
          </p>
        )}

        <section className="controls-row">
          <div className="search-column">
            <input
              type="text"
              className="search-input"
              placeholder="Search athlete (use commas for multiple names)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <div className="filter-row">
              <select
                className="filter-button"
                value={filterTeam}
                onChange={(e) => setFilterTeam(e.target.value)}
              >
                <option value="">Filter by team</option>
                {uniqueTeams.map((team) => (
                  <option key={team} value={team}>
                    {team}
                  </option>
                ))}
              </select>
              <select
                className="filter-button"
                value={filterGrade}
                onChange={(e) => setFilterGrade(e.target.value)}
              >
                <option value="">Filter by grade</option>
                {uniqueGrades.map((grade) => (
                  <option key={grade} value={grade}>
                    {grade}
                  </option>
                ))}
              </select>
              <input
                type="text"
                className="birthdate-input"
                placeholder="Search birthdate"
                value={filterBirthdate}
                onChange={(e) => setFilterBirthdate(e.target.value)}
              />
            </div>
          </div>

          <label className={`upload-box ${!canUpload ? 'disabled' : ''}`}>
            <input
              type="file"
              accept=".csv,text/csv,.xlsx,.xls,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              multiple
              onChange={handleFilesUpload}
              disabled={!canUpload}
            />
            {isUploading ? 'Uploading...' : user ? 'Upload data' : 'Sign in to upload'}
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

          <div className="column-visibility-row">
            <span className="column-visibility-label">Show columns:</span>
            <div className="column-visibility-options">
              {tableColumns.map((column) => (
                <label key={column.id} className="column-toggle">
                  <input
                    type="checkbox"
                    checked={visibleColumns[column.id]}
                    onChange={() => handleToggleColumn(column.id)}
                  />
                  <span>{column.label}</span>
                </label>
              ))}
            </div>
          </div>

          {filteredRows.length === 0 ? (
            <p className="empty-state">
              {isLoadingFirebase
                ? 'Loading athletes...'
                : allAthletes.length === 0
                  ? 'Upload one or more spreadsheet files to preview parsed data.'
                : 'No athletes match your search or filter.'}
            </p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {renderedColumns.map((column) => (
                      <th key={column.id}>{column.label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {filteredRows.slice(0, 120).map((row, index) => (
                    <tr key={`${row.athleteKey}-${row.team}-${index}`}>
                      {renderedColumns.map((column) => (
                        <td key={`${row.athleteKey}-${column.id}`}>{row[column.id]}</td>
                      ))}
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
