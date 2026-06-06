const SUPABASE_URL = 'https://oaapgalsprualadbfltv.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9hYXBnYWxzcHJ1YWxhZGJmbHR2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODA3NTQ0ODAsImV4cCI6MjA5NjMzMDQ4MH0.JP50HnTaKMg8gv38_tu81gcbTvGEhb6qY1pVzDq5XtE';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let currentUser = null;
let currentCar = null;
let currentCarMembers = [];
let calculatedOdometer = 0; // מד אוץ משוער שמנוהל ברקע

async function login() { await supabaseClient.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.origin } }); }
async function logout() { await supabaseClient.auth.signOut(); showScreen('login-screen'); }

function showScreen(screenId) {
    ['login-screen', 'cars-screen', 'app-screen'].forEach(id => document.getElementById(id).classList.add('hidden'));
    document.getElementById(screenId).classList.remove('hidden');
}

function switchView(viewName, navElement) {
    document.querySelectorAll('.app-view').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.getElementById('view-' + viewName).classList.remove('hidden');
    if(navElement) navElement.classList.add('active');
    
    if(viewName === 'dashboard') loadDashboardData();
    if(viewName === 'trip') prepareTripForm();
}

async function initializeApp(user) {
    currentUser = user;
    try {
        const { data: existingProfile } = await supabaseClient.from('profiles').select('*').eq('id', user.id).maybeSingle();
        if (!existingProfile) {
            await supabaseClient.from('profiles').insert({ id: user.id, display_name: user.user_metadata.full_name, email: user.email });
            document.getElementById('user-display-name').innerText = user.user_metadata.full_name || 'ללא שם';
        } else {
            document.getElementById('user-display-name').innerText = existingProfile.display_name || 'ללא שם';
        }
        document.getElementById('user-email-display').innerText = user.email;
    } catch(e) { console.warn("שגיאת פרופיל", e); }
    
    await loadUserCars();
    showScreen('cars-screen');
}

async function editDisplayName() {
    const currentName = document.getElementById('user-display-name').innerText;
    const newName = prompt("הכנס כינוי חדש:", currentName);
    if (newName && newName.trim() !== "") {
        await supabaseClient.from('profiles').update({ display_name: newName.trim() }).eq('id', currentUser.id);
        document.getElementById('user-display-name').innerText = newName.trim();
    }
}

async function loadUserCars() {
    const listDiv = document.getElementById('my-cars-list');
    listDiv.innerHTML = 'טוען רכבים...';

    // קליטת הזמנות
    try {
        const { data: invites } = await supabaseClient.from('invitations').select('*').eq('invited_email', currentUser.email.toLowerCase());
        if (invites && invites.length > 0) {
            for (let inv of invites) {
                await supabaseClient.from('group_members').upsert({ group_id: inv.group_id, user_id: currentUser.id });
                await supabaseClient.from('invitations').delete().eq('id', inv.id);
            }
        }
    } catch(e) {}

    const { data: members, error } = await supabaseClient.from('group_members').select(`group_id, car_groups (id, name, initial_odo)`).eq('user_id', currentUser.id);
    if (error) return listDiv.innerHTML = 'שגיאה: ' + error.message; 
    
    if (!members || members.length === 0) {
        listDiv.innerHTML = '<p>אין לך רכבים.</p>';
    } else {
        listDiv.innerHTML = '';
        members.forEach(member => {
            if(!member.car_groups) return; 
            const div = document.createElement('div');
            div.className = 'car-list-item';
            div.innerHTML = `<div style="flex:1" onclick='enterCar(${JSON.stringify(member.car_groups)})'><strong>${member.car_groups.name || 'רכב ללא שם'}</strong></div>`;
            listDiv.appendChild(div);
        });
    }
}

function showCreateCarForm() { document.getElementById('create-car-form').classList.remove('hidden'); }
function hideCreateCarForm() { document.getElementById('create-car-form').classList.add('hidden'); }

async function createCar() {
    const name = document.getElementById('new-car-name').value;
    const initialOdo = document.getElementById('new-car-odo').value;
    if (!name || !initialOdo) return alert("חסרים פרטים");
    
    const { data: newCar } = await supabaseClient.from('car_groups').insert({ name: name, initial_odo: parseFloat(initialOdo) }).select().single();
    await supabaseClient.from('group_members').insert({ group_id: newCar.id, user_id: currentUser.id });
    hideCreateCarForm();
    loadUserCars();
}

function enterCar(carObj) {
    currentCar = carObj;
    document.getElementById('active-car-name').innerText = carObj.name || 'רכב';
    switchView('dashboard', document.querySelector('.bottom-nav .nav-item')); 
    showScreen('app-screen');
}

function backToCars() {
    currentCar = null;
    currentCarMembers = [];
    document.getElementById('whatsapp-share-container').classList.add('hidden');
    loadUserCars();
    showScreen('cars-screen');
}

// עדכון התצוגה של טופס נסיעה
function toggleTripInput() {
    const type = document.getElementById('trip-input-type').value;
    if(type === 'distance') {
        document.getElementById('trip-distance-container').classList.remove('hidden');
        document.getElementById('trip-odo-container').classList.add('hidden');
    } else {
        document.getElementById('trip-distance-container').classList.add('hidden');
        document.getElementById('trip-odo-container').classList.remove('hidden');
    }
}

function prepareTripForm() {
    document.getElementById('current-odo-hint').innerText = `מד אוץ אחרון ידוע: ${calculatedOdometer}`;
    
    const participantsDiv = document.getElementById('trip-participants-list');
    participantsDiv.innerHTML = '';
    
    currentCarMembers.forEach(m => {
        const isMe = m.profiles.id === currentUser.id;
        participantsDiv.innerHTML += `
            <div class="checkbox-item">
                <input type="checkbox" id="part-${m.profiles.id}" value="${m.profiles.id}" ${isMe ? 'checked' : ''}>
                <label for="part-${m.profiles.id}" style="margin:0; font-weight:normal;">${isMe ? 'אני' : m.profiles.display_name}</label>
            </div>
        `;
    });
}

async function loadDashboardData() {
    if(!currentCar) return;

    const { data: refuels } = await supabaseClient.from('refuels').select('*').eq('group_id', currentCar.id).order('created_at', { ascending: false });
    const { data: trips } = await supabaseClient.from('trips').select('*, profiles(display_name)').eq('group_id', currentCar.id).order('created_at', { ascending: false });
    const { data: members } = await supabaseClient.from('group_members').select('profiles(id, display_name, email)').eq('group_id', currentCar.id);
    const { data: participants } = await supabaseClient.from('trip_participants').select('*');

    currentCarMembers = members || [];
    const safeRefuels = refuels || [];
    const safeTrips = trips || [];
    const safeParticipants = participants || [];

    // חישוב מד אוץ נוכחי
    let lastRefuelOdo = safeRefuels.length > 0 ? safeRefuels[0].odometer : currentCar.initial_odo;
    let tripsSinceRefuel = 0;
    const lastRefuelDate = safeRefuels.length > 0 ? new Date(safeRefuels[0].created_at) : new Date(0);
    
    safeTrips.forEach(t => {
        if(new Date(t.created_at) > lastRefuelDate) {
            tripsSinceRefuel += Number(t.distance);
        }
    });
    calculatedOdometer = lastRefuelOdo + tripsSinceRefuel;
    document.getElementById('dash-current-odo').innerText = calculatedOdometer.toFixed(0);

    // חישובים כלכליים וקילומטרים (מתחשב בחלוקה למספר משתתפים בנסיעה)
    let totalCost = 0, totalTripsKm = 0;
    let paymentsByUser = {}, kmByUser = {};

    currentCarMembers.forEach(m => {
        paymentsByUser[m.profiles.id] = { name: m.profiles.display_name, paid: 0 };
        kmByUser[m.profiles.id] = { name: m.profiles.display_name, km: 0 };
    });

    safeRefuels.forEach(r => {
        totalCost += Number(r.cost);
        if(paymentsByUser[r.paid_by]) paymentsByUser[r.paid_by].paid += Number(r.cost);
    });

    safeTrips.forEach(t => {
        totalTripsKm += Number(t.distance);
        
        // מציאת כל מי שהשתתף בנסיעה הספציפית
        let tripParts = safeParticipants.filter(p => p.trip_id === t.id);
        if(tripParts.length > 0) {
            let splitDistance = Number(t.distance) / tripParts.length;
            tripParts.forEach(p => {
                if(kmByUser[p.user_id]) kmByUser[p.user_id].km += splitDistance;
            });
        } else {
            // תאימות לאחור: אם אין משתתפים מתועדים, הכל הולך למי שרשמה
            if(kmByUser[t.recorded_by]) kmByUser[t.recorded_by].km += Number(t.distance);
        }
    });

    let avgCostPerKm = totalTripsKm > 0 ? (totalCost / totalTripsKm) : 0;
    document.getElementById('dash-total-cost').innerText = `₪${totalCost.toFixed(0)}`;
    document.getElementById('dash-avg-cost').innerText = totalTripsKm > 0 ? `₪${avgCostPerKm.toFixed(2)}` : '0';
    document.getElementById('dash-total-km').innerText = totalTripsKm.toFixed(1);

    // טבלת התחשבנות - הטור "שותפה" אחרון
    let balanceHTML = '<table><tr><th>מצב</th><th>נסעה (ק"מ)</th><th>שילמה</th><th>שותפה</th></tr>';
    currentCarMembers.forEach(m => {
        let id = m.profiles.id;
        let displayName = id === currentUser.id ? 'את/ה' : (m.profiles.display_name || 'אנונימית');
        let finalBalance = paymentsByUser[id].paid - (kmByUser[id].km * avgCostPerKm);
        let color = finalBalance >= 0 ? 'var(--success)' : 'var(--danger)';
        
        balanceHTML += `<tr>
            <td style="color: ${color}; font-weight:bold; direction:ltr;">${finalBalance > 0 ? '+' : ''}${finalBalance.toFixed(0)}₪</td>
            <td>${kmByUser[id].km.toFixed(1)}</td>
            <td>₪${paymentsByUser[id].paid.toFixed(0)}</td>
            <td>${displayName}</td>
        </tr>`;
    });
    balanceHTML += '</table>';
    document.getElementById('dash-balances').innerHTML = totalTripsKm > 0 ? balanceHTML : '<p>אין מספיק נתונים.</p>';

    // טבלת נסיעות אחרונות - הוספנו מד אוץ סופי, והערה
    let tripsHTML = '<table><tr><th>מד אוץ סופי</th><th>מרחק</th><th>הערה</th><th>נהגת</th><th>תאריך</th></tr>';
    safeTrips.slice(0, 8).forEach(t => {
        let date = new Date(t.created_at).toLocaleDateString('he-IL', {day: '2-digit', month: '2-digit'});
        let displayName = t.recorded_by === currentUser.id ? 'את/ה' : (t.profiles?.display_name || '');
        let endOdoDisplay = t.end_odo ? t.end_odo : '-';
        let noteDisplay = t.note ? t.note : '-';
        
        tripsHTML += `<tr>
            <td>${endOdoDisplay}</td>
            <td>${t.distance}</td>
            <td>${noteDisplay}</td>
            <td>${displayName}</td>
            <td>${date}</td>
        </tr>`;
    });
    tripsHTML += '</table>';
    document.getElementById('dash-trips-list').innerHTML = safeTrips.length > 0 ? tripsHTML : '<p>אין נסיעות.</p>';
}

// שמירת נסיעה חדשה עם משתתפים ובדיקות תקינות
async function saveTrip() {
    let distance = 0;
    let endOdo = null;
    const type = document.getElementById('trip-input-type').value;
    
    if(type === 'distance') {
        distance = parseFloat(document.getElementById('trip-distance').value);
        if(!distance || distance <= 0) return alert("הזני מרחק תקין");
        endOdo = calculatedOdometer + distance;
    } else {
        endOdo = parseFloat(document.getElementById('trip-end-odo').value);
        if(!endOdo) return alert("הזני מד אוץ חדש");
        if(endOdo < calculatedOdometer) {
            if(!confirm(`זהירות: מד האוץ שהזנת (${endOdo}) נמוך ממד האוץ הנוכחי המחושב (${calculatedOdometer}). בטוחה שזה נכון?`)) return;
        }
        distance = endOdo - calculatedOdometer;
        if(distance < 0) distance = 0; // מניעת מרחק שלילי בטעות משתמש
    }

    if(distance > 200) {
        if(!confirm(`הוזנה נסיעה של מעל 200 ק"מ. לשמור?`)) return;
    }

    const note = document.getElementById('trip-note').value.trim();

    // איסוף משתתפות שסומנו ב-V
    let selectedParticipants = [];
    currentCarMembers.forEach(m => {
        const checkbox = document.getElementById(`part-${m.profiles.id}`);
        if(checkbox && checkbox.checked) selectedParticipants.push(m.profiles.id);
    });

    if(selectedParticipants.length === 0) return alert("חייבת לבחור לפחות משתתפת אחת בנסיעה");

    // שמירה לטבלת trips
    const { data: newTrip, error } = await supabaseClient.from('trips').insert({ 
        group_id: currentCar.id, 
        recorded_by: currentUser.id, 
        distance: distance,
        end_odo: endOdo,
        note: note
    }).select().single();

    if (error) return alert("שגיאה בשמירה: " + error.message);
    
    // שמירה לטבלת המשתתפים
    const participantsData = selectedParticipants.map(userId => ({ trip_id: newTrip.id, user_id: userId }));
    await supabaseClient.from('trip_participants').insert(participantsData);

    alert("נשמר בהצלחה!");
    document.getElementById('trip-distance').value = '';
    document.getElementById('trip-end-odo').value = '';
    document.getElementById('trip-note').value = '';
    switchView('dashboard', document.querySelector('.bottom-nav .nav-item')); 
}

async function saveRefuel() {
    const cost = parseFloat(document.getElementById('refuel-cost').value);
    const liters = parseFloat(document.getElementById('refuel-liters').value);
    const odo = parseFloat(document.getElementById('refuel-odo').value);

    if (!cost || !liters || !odo) return alert("נא למלא את כל השדות");
    
    if(odo < calculatedOdometer) {
        if(!confirm(`זהירות: מד האוץ שהזנת (${odo}) נמוך מהמד המחושב שלנו (${calculatedOdometer}). להמשיך?`)) return;
    }

    const { error } = await supabaseClient.from('refuels').insert({ group_id: currentCar.id, paid_by: currentUser.id, cost: cost, liters: liters, odometer: odo });
    if (error) return alert("שגיאה בשמירה: " + error.message);
    
    alert("נשמר בהצלחה!");
    document.getElementById('refuel-cost').value = ''; document.getElementById('refuel-liters').value = ''; document.getElementById('refuel-odo').value = '';
    switchView('dashboard', document.querySelector('.bottom-nav .nav-item')); 
}

// הזמנות
async function inviteUser() {
    const email = document.getElementById('invite-email').value.toLowerCase().trim();
    if (!email) return alert("נא להזין אימייל");
    const { error } = await supabaseClient.from('invitations').insert({ group_id: currentCar.id, invited_email: email, invited_by: currentUser.id });
    if (error) alert("שגיאה: " + error.message);
    else {
        alert(`הזמנה נשמרה.`);
        document.getElementById('invite-email').value = '';
        document.getElementById('whatsapp-share-container').classList.remove('hidden');
    }
}
function shareWhatsApp() {
    const text = encodeURIComponent(`היי! הוספתי אותך לרכב "${currentCar.name}" באפליקציית הדלק 🚗\nכנסי ללינק ותתחברי עם הג'ימייל:\n${window.location.origin}`);
    window.open(`https://wa.me/?text=${text}`, '_blank');
}

// אתחול
supabaseClient.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && session) initializeApp(session.user);
    else if (event === 'SIGNED_OUT') currentUser = null;
});
supabaseClient.auth.getSession().then(({ data: { session } }) => {
    if (session && session.user) initializeApp(session.user);
});
