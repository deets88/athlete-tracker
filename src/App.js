import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import './App.css';
import AuthButton from './components/AuthButton';
import { auth, db, isFirebaseReady } from './firebase';
import {
  addDoc,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
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
  const [deletedAthletes, setDeletedAthletes] = useState([]);
  const [user, setUser] = useState(null);
  const [isLoadingDeleted, setIsLoadingDeleted] = useState(false);
  const [deletionStatus, setDeletionStatus] = useState('');
  const [selectedAthletes, setSelectedAthletes] = useState(new Set());
  const [selectedDeleted, setSelectedDeleted] = useState(new Set());
  const [viewMode, setViewMode] = useState('active');
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
  const [visibleColumns, setVisibleColumns] = useState(defaultVisibleColumns);
  const [sortBy, setSortBy] = useState('lastName');
  const [sortDir, setSortDir] = useState('asc');

  const handleSort = (columnId) => {
    if (sortBy === columnId) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortBy(columnId);
      setSortDir('asc');
    }
  };

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

    const rows = allAthletes.filter((row) => {
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

      return matchesSearch && matchesTeamFilter && matchesGradeFilter;
    });

    const compare = (a, b) => {
      const aVal = `${(a[sortBy] ?? '')}`.toLowerCase();
      const bVal = `${(b[sortBy] ?? '')}`.toLowerCase();
      const aNum = parseFloat(aVal.replace(/[^0-9.-]/g, ''));
      const bNum = parseFloat(bVal.replace(/[^0-9.-]/g, ''));
      const bothNumeric = !Number.isNaN(aNum) && !Number.isNaN(bNum);

      if (bothNumeric) return aNum - bNum;
      if (aVal < bVal) return -1;
      if (aVal > bVal) return 1;
      return 0;
    };

    rows.sort((a, b) => (sortDir === 'asc' ? compare(a, b) : -compare(a, b)));

    return rows;
  }, [allAthletes, searchQuery, filterTeam, filterGrade, sortBy, sortDir]);

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
        // birthdate intentionally omitted
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

  // Load deleted athletes from trash collection
  const loadDeletedAthletes = async () => {
    if (!isFirebaseReady || !user) return;

    try {
      setIsLoadingDeleted(true);
      const snapshot = await getDocs(collection(db, 'deletedAthletes'));
      const deleted = snapshot.docs.map((docSnap) => ({ athleteKey: docSnap.id, ...docSnap.data() }));
      setDeletedAthletes(deleted);
    } catch (error) {
      setDeletionStatus(`Failed to load deleted athletes: ${getErrorMessage(error)}`);
    } finally {
      setIsLoadingDeleted(false);
    }
  };

  // Move selected athletes to trash
  const handleDeleteSelected = async () => {
    if (selectedAthletes.size === 0) {
      setDeletionStatus('No athletes selected for deletion.');
      return;
    }

    if (!isFirebaseReady || !user) return;

    try {
      setDeletionStatus(`Moving ${selectedAthletes.size} athlete(s) to trash...`);

      const athletesToDelete = allAthletes.filter((a) => selectedAthletes.has(a.athleteKey));

      const deleteOps = athletesToDelete.map(async (athlete) => {
        const activeRef = doc(db, 'athletes', athlete.athleteKey);
        const trashedRef = doc(db, 'deletedAthletes', athlete.athleteKey);

        // Read full source document to preserve all fields
        const srcSnap = await getDoc(activeRef);
        const srcData = srcSnap && srcSnap.exists() ? srcSnap.data() : null;

        const dataToStore = srcData ? { ...srcData } : { ...athlete };
        dataToStore.deletedAt = serverTimestamp();

        // Copy full doc to deleted collection
        await setDoc(trashedRef, dataToStore);

        // Remove from active collection
        await deleteDoc(activeRef);
      });

      await Promise.all(deleteOps);

      setAllAthletes((prev) => prev.filter((a) => !selectedAthletes.has(a.athleteKey)));
      setSelectedAthletes(new Set());
      setDeletionStatus(`Moved ${athletesToDelete.length} athlete(s) to trash.`);
    } catch (error) {
      setDeletionStatus(`Failed to delete athletes: ${getErrorMessage(error)}`);
    }
  };

  // Restore athlete from trash
  const handleRestoreAthlete = async (athlete) => {
    if (!isFirebaseReady || !user) return;

    try {
      setDeletionStatus(`Restoring ${athlete.firstName} ${athlete.lastName}...`);

      const activeRef = doc(db, 'athletes', athlete.athleteKey);
      const trashedRef = doc(db, 'deletedAthletes', athlete.athleteKey);

      // Read full trashed document (in case UI passed a hydrated/partial object)
      const trashedSnap = await getDoc(trashedRef);
      const trashedData = trashedSnap && trashedSnap.exists() ? trashedSnap.data() : athlete;

      const { deletedAt, ...athleteData } = trashedData;
      await setDoc(activeRef, athleteData);

      // Remove from deleted collection
      await deleteDoc(trashedRef);

      setDeletedAthletes((prev) => prev.filter((a) => a.athleteKey !== athlete.athleteKey));
      setAllAthletes((prev) => [...prev, hydrateAthlete(athlete.athleteKey, athleteData)]);
      setDeletionStatus(`Restored ${athlete.firstName} ${athlete.lastName}.`);
    } catch (error) {
      setDeletionStatus(`Failed to restore athlete: ${getErrorMessage(error)}`);
    }
  };

  // Permanently delete from trash
  const handlePermanentlyDelete = async (athlete) => {
    if (!isFirebaseReady || !user) return;

    const confirmed = window.confirm(
      `Permanently delete ${athlete.firstName} ${athlete.lastName}? This cannot be undone.`
    );

    if (!confirmed) return;

    try {
      setDeletionStatus(`Permanently deleting ${athlete.firstName} ${athlete.lastName}...`);

      const trashedRef = doc(db, 'deletedAthletes', athlete.athleteKey);
      await deleteDoc(trashedRef);

      setDeletedAthletes((prev) => prev.filter((a) => a.athleteKey !== athlete.athleteKey));
      setDeletionStatus(`Permanently deleted ${athlete.firstName} ${athlete.lastName}.`);
    } catch (error) {
      setDeletionStatus(`Failed to permanently delete athlete: ${getErrorMessage(error)}`);
    }
  };

  const handleSelectAthlete = (athleteKey) => {
    setSelectedAthletes((prev) => {
      const updated = new Set(prev);
      if (updated.has(athleteKey)) {
        updated.delete(athleteKey);
      } else {
        updated.add(athleteKey);
      }
      return updated;
    });
  };

  const handleSelectAll = (rowsToSelect) => {
    if (selectedAthletes.size === rowsToSelect.length) {
      setSelectedAthletes(new Set());
    } else {
      setSelectedAthletes(new Set(rowsToSelect.map((row) => row.athleteKey)));
    }
  };

  // Deleted (trash) selection handlers
  const handleSelectDeletedAthlete = (athleteKey) => {
    setSelectedDeleted((prev) => {
      const updated = new Set(prev);
      if (updated.has(athleteKey)) {
        updated.delete(athleteKey);
      } else {
        updated.add(athleteKey);
      }
      return updated;
    });
  };

  const handleSelectAllDeleted = (rowsToSelect) => {
    if (selectedDeleted.size === rowsToSelect.length) {
      setSelectedDeleted(new Set());
    } else {
      setSelectedDeleted(new Set(rowsToSelect.map((row) => row.athleteKey)));
    }
  };

  const handleRestoreSelected = async () => {
    if (selectedDeleted.size === 0) {
      setDeletionStatus('No deleted athletes selected.');
      return;
    }

    try {
      setDeletionStatus(`Restoring ${selectedDeleted.size} athlete(s)...`);
      const toRestore = deletedAthletes.filter((a) => selectedDeleted.has(a.athleteKey));

      const ops = toRestore.map(async (athlete) => {
        const activeRef = doc(db, 'athletes', athlete.athleteKey);
        const trashedRef = doc(db, 'deletedAthletes', athlete.athleteKey);
        const trashedSnap = await getDoc(trashedRef);
        const trashedData = trashedSnap && trashedSnap.exists() ? trashedSnap.data() : athlete;
        const { deletedAt, ...athleteData } = trashedData;
        await setDoc(activeRef, athleteData);
        await deleteDoc(trashedRef);
      });

      await Promise.all(ops);
      setAllAthletes((prev) => [...prev, ...toRestore.map((a) => hydrateAthlete(a.athleteKey, a))]);
      setDeletedAthletes((prev) => prev.filter((a) => !selectedDeleted.has(a.athleteKey)));
      setSelectedDeleted(new Set());
      setDeletionStatus(`Restored ${toRestore.length} athlete(s).`);
    } catch (error) {
      setDeletionStatus(`Failed to restore selected athletes: ${getErrorMessage(error)}`);
    }
  };

  const handleDeleteSelectedPermanently = async () => {
    if (selectedDeleted.size === 0) {
      setDeletionStatus('No deleted athletes selected.');
      return;
    }

    const confirmed = window.confirm(`Permanently delete ${selectedDeleted.size} athlete(s)? This cannot be undone.`);
    if (!confirmed) return;

    try {
      setDeletionStatus(`Permanently deleting ${selectedDeleted.size} athlete(s)...`);
      const toDelete = deletedAthletes.filter((a) => selectedDeleted.has(a.athleteKey));

      const ops = toDelete.map(async (athlete) => {
        const trashedRef = doc(db, 'deletedAthletes', athlete.athleteKey);
        await deleteDoc(trashedRef);
      });

      await Promise.all(ops);
      setDeletedAthletes((prev) => prev.filter((a) => !selectedDeleted.has(a.athleteKey)));
      setSelectedDeleted(new Set());
      setDeletionStatus(`Permanently deleted ${toDelete.length} athlete(s).`);
    } catch (error) {
      setDeletionStatus(`Failed to permanently delete selected athletes: ${getErrorMessage(error)}`);
    }
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
            <div>
              <h2>{viewMode === 'active' ? 'Athlete Data' : 'Deleted Athletes'}</h2>
              <div className="view-tabs">
                <button
                  className={`view-tab ${viewMode === 'active' ? 'active' : ''}`}
                  onClick={() => {
                    setViewMode('active');
                    setSelectedAthletes(new Set());
                  }}
                >
                  Active ({allAthletes.length})
                </button>
                <button
                  className={`view-tab ${viewMode === 'deleted' ? 'active' : ''}`}
                  onClick={() => {
                    setViewMode('deleted');
                    loadDeletedAthletes();
                  }}
                >
                  Trash ({deletedAthletes.length})
                </button>
              </div>
            </div>
            {viewMode === 'active' && (
              <div className="preview-meta">
                <span>Rows: {displaySummary.rowCount}</span>
                <span>Athletes: {displaySummary.athleteCount}</span>
                <span>Teams: {displaySummary.teamCount}</span>
              </div>
            )}
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

          {viewMode === 'active' ? (
            <>
              {selectedAthletes.size > 0 && (
                <div className="selection-controls">
                  <span className="selection-count">{selectedAthletes.size} athlete(s) selected</span>
                  <button className="delete-button" onClick={handleDeleteSelected}>
                    Delete Selected
                  </button>
                </div>
              )}

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
                        <th className="checkbox-column">
                          <input
                            type="checkbox"
                            checked={selectedAthletes.size === filteredRows.length && filteredRows.length > 0}
                            onChange={() => handleSelectAll(filteredRows)}
                            title="Select all"
                          />
                        </th>
                        {renderedColumns.map((column) => (
                          <th key={column.id} className="sortable" onClick={() => handleSort(column.id)}>
                            {column.label} {sortBy === column.id ? (sortDir === 'asc' ? '▲' : '▼') : '↕'}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRows.slice(0, 120).map((row, index) => (
                        <tr key={`${row.athleteKey}-${row.team}-${index}`}>
                          <td className="checkbox-column">
                            <input
                              type="checkbox"
                              checked={selectedAthletes.has(row.athleteKey)}
                              onChange={() => handleSelectAthlete(row.athleteKey)}
                            />
                          </td>
                          {renderedColumns.map((column) => (
                            <td key={`${row.athleteKey}-${column.id}`}>{row[column.id]}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <div>
              {isLoadingDeleted ? (
                <p className="empty-state">Loading deleted athletes...</p>
              ) : deletedAthletes.length === 0 ? (
                <p className="empty-state">No deleted athletes.</p>
              ) : (
                <>
                  {selectedDeleted.size > 0 && (
                    <div className="selection-controls">
                      <span className="selection-count">{selectedDeleted.size} deleted athlete(s) selected</span>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button className="action-button restore-button" onClick={handleRestoreSelected}>
                          Restore Selected
                        </button>
                        <button className="delete-button" onClick={handleDeleteSelectedPermanently}>
                          Delete Selected Permanently
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th className="checkbox-column">
                            <input
                              type="checkbox"
                              checked={selectedDeleted.size === deletedAthletes.length && deletedAthletes.length > 0}
                              onChange={() => handleSelectAllDeleted(deletedAthletes)}
                              title="Select all deleted"
                            />
                          </th>
                          <th>Name</th>
                          <th>Student Number</th>
                          <th>Email</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {deletedAthletes.map((athlete) => (
                          <tr key={athlete.athleteKey}>
                            <td className="checkbox-column">
                              <input
                                type="checkbox"
                                checked={selectedDeleted.has(athlete.athleteKey)}
                                onChange={() => handleSelectDeletedAthlete(athlete.athleteKey)}
                              />
                            </td>
                            <td>{athlete.firstName} {athlete.lastName}</td>
                            <td>{athlete.studentNumber}</td>
                            <td>{athlete.email}</td>
                            <td>
                              <button
                                className="action-button restore-button"
                                onClick={() => handleRestoreAthlete(athlete)}
                              >
                                Restore
                              </button>
                              <button
                                className="action-button delete-button"
                                onClick={() => handlePermanentlyDelete(athlete)}
                              >
                                Delete Permanently
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;
