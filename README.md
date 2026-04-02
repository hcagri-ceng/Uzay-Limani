<h1>SpacePort Simulator</h1>
<h2>Our Team Members</h2>

<table style="width:100%">
  <tr>
    <th>Name</th>
    <th>Surname</th>
    <th>Linkedin Profile</th>
  </tr>
  <tr>
    <td>Göktuğ Ferdi</td>
    <td>Uylaş</td>
    <td><a href="https://www.linkedin.com/in/göktuğ-ferdi-uylaş-a71328297" target="_blank">
      <img src="https://cdn-icons-png.flaticon.com/512/174/174857.png" 
           alt="LinkedIn" 
           width="24" 
           height="24">
    </a>
      </td>
  </tr>
    <tr>
    <td>Hasan Çağrı</td>
    <td>Tuncer</td>
     <td><a href="https://www.linkedin.com/in/hcagrituncer/" target="_blank">
      <img src="https://cdn-icons-png.flaticon.com/512/174/174857.png" 
           alt="LinkedIn" 
           width="24" 
           height="24">
     </a>
     </td>
     </tr>
     <tr>
         <td>Burak</td>
         <td>Karadaş</td>
          <td><a href="https://www.linkedin.com/in/burak-karada%C5%9F/" target="_blank">
      <img src="https://cdn-icons-png.flaticon.com/512/174/174857.png" 
           alt="LinkedIn" 
           width="24" 
           height="24">
          </a>
          </td>
          </tr>
          <tr>
            <td>Mehmet Fırat</td>
            <td>Yılmaz</td>
            <td><a href="https://www.linkedin.com/in/f%C4%B1rat-y%C4%B1lmaz-766002339/" target="_blank">
      <img src="https://cdn-icons-png.flaticon.com/512/174/174857.png" 
           alt="LinkedIn" 
           width="24" 
           height="24">
            </a>
            </td>
          </tr>
           </tr>
</table>

# SpacePort Simulator 🚀

SpacePort Simulator is an interactive web-based application designed to evaluate the suitability of specific geographical locations for spaceport construction (rocket launch and landing facilities). By processing real-time environmental and topographical data, the system provides a comprehensive feasibility score for any selected region on Earth.

## 🛠️ Tech Stack

**Frontend:**
* React
* Vite
* Three.js (for 3D rendering and visualizations)
* Tailwind CSS (for styling)

**Backend:**
* Python
* FastAPI
* Uvicorn (ASGI web server)
* Pydantic (for data validation)

## ⚙️ How It Works

1. **Location Selection:** The user begins by selecting a country and a specific city from the interactive interface.
2. **Boundary Definition & Pinpointing:** The boundaries of the chosen city are rendered on the screen. The user can then pinpoint a specific coordinate within these borders.
3. **Data Aggregation:** Upon selection, the backend seamlessly triggers a data collection pipeline using external APIs to assess the location's viability.
4. **Feasibility Scoring:** The system calculates an overall suitability score based on meteorological conditions, topological structure, and logistical infrastructure. This scoring mechanism translates complex data into an easily understandable, user-friendly format.

## 📡 APIs Used

The application relies on the following APIs for background data processing:
* **Weather API:** For real-time meteorological conditions and climate checks.
* **Overpass API:** For logistical and regional infrastructure analysis.
* **Open Elevation API:** For topological and terrain elevation data.

## 🔑 Configuration & API Keys

> **Note:** The API keys currently configured in the project are trial/development keys. If you encounter rate limits or connection issues during future use, you will need to replace them with your own API keys in the environment variables to ensure uninterrupted access.

## 🔭 Project Vision

Our primary goal with SpacePort Simulator is to create a dynamic monitoring tool. The physical world is constantly changing; thanks to our API-driven architecture, the system can continuously track shifts in weather patterns or logistical developments in a selected region, ensuring that the spaceport suitability assessments remain up-to-date and accurate over time.


